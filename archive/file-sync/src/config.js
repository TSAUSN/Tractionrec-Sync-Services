"use strict";

/**
 * Configuration and the tier map.
 *
 * The tier map is the single place that knows how a Traction Rec object lines
 * up with a Zesty model. Everything else in this service is generic over it.
 *
 * Field names on both sides are verified, not assumed:
 *   - Traction Rec  -> KROC-draft/tractionrec-sandbox-content-model.md
 *   - Zesty         -> Kroc-Center-Template/webengine/views/custom-endpoints/*.json
 */

/** Read a dotted path out of a raw Salesforce record, tolerating nulls. */
const at = (rec, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), rec);

/** Everything on the bookable unit hangs off this lookup. */
const OPT = "TREX1__Course_Option__r";

/** "18:00:00.000" -> "18:00" */
const trimSeconds = (t) => (typeof t === "string" ? t.slice(0, 5) : t);

/** "18:00" -> "6:00 PM", matching how the authored class items read. */
function to12Hour(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
  if (!m) {
    return "";
  }
  const h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${m[2]} ${suffix}`;
}

/**
 * `day_of_week` is a Zesty DROPDOWN of single days (monday…sunday, lowercase
 * keys) and TREX1__Day_of_Week__c is a multipicklist where 65% of options are
 * multi-day. There is no value that represents "Tuesday;Thursday", so the
 * field is only set when Traction Rec names exactly one day. The full value
 * always survives in the snapshot's `TREX1__Course_Option__r.TREX1__Day_of_Week__c`, which is what a template
 * should render.
 */
function singleDayOrBlank(multipicklist) {
  const days = String(multipicklist || "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  return days.length === 1 ? days[0].toLowerCase() : "";
}

/** First price level of a given TREX1__Price_Type__c, as a number. */
function priceOfType(snapshot, type) {
  const level = ((snapshot && snapshot.prices) || []).find((p) => p.priceType === type);
  return level && level.amount != null ? level.amount : "";
}

/**
 * `enrollment_status` is a dropdown: open | full | waitlist | closed. Traction
 * Rec has no such field, so it is derived. Seeded on create only — it is one
 * of the volatile five, and the snapshot stays the live source.
 */
function enrollmentStatus(tr) {
  // 25 of 945 options are uncapped; a spot count of 0 there does not mean full.
  if (at(tr, `${OPT}.TREX1__Unlimited_Capacity__c`)) {
    return "open";
  }
  const spots = Number(at(tr, `${OPT}.TREX1__Total_Capacity_Available__c`));
  if (!Number.isFinite(spots)) {
    return "";
  }
  if (spots > 0) {
    return "open";
  }
  const capacity = Number(at(tr, `${OPT}.TREX1__Waitlist_Capacity__c`));
  const taken = Number(at(tr, `${OPT}.TREX1__Waitlist_Total__c`)) || 0;
  return Number.isFinite(capacity) && capacity > taken ? "waitlist" : "full";
}

/** Render a from/to pair, tolerating either end being absent. */
function joinRange(from, to, sep = "\u2013", prefix = "") {
  const has = (v) => v != null && v !== "";
  if (!has(from) && !has(to)) {
    return "";
  }
  if (!has(from)) {
    return `${prefix}${to}`;
  }
  if (!has(to)) {
    return `${prefix}${from}`;
  }
  return `${prefix}${from}${sep}${to}`;
}

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : v === "1" || v === "true");

/**
 * Views are written under this folder: /tractionrec/<tier>/<trId>.json
 *
 * The LEADING SLASH is load-bearing. Verified: every ajax-json view
 * that serves on the live domain has one, and a view created without it is
 * accepted by the API, reports `status: live`, and then 404s on every request.
 */
const SNAPSHOT_ROOT = "/tractionrec";

/** Where the watermark/hash ledger lives. Same folder, leading underscore. */
const STATE_FILE = `${SNAPSHOT_ROOT}/_sync-state.json`;

/**
 * Every Zesty catalog model carries this field. It is the join key and the
 * ONLY field this service writes on an existing item — see docs/sync-flow.md.
 */
const TR_ID_FIELD = "tractionrec_id";

const TIERS = {
  program_categories: {
    label: "Program Category",
    /** Zesty model reference name; the ZUID is resolved at runtime. */
    zestyModel: "categories",
    trObject: "TREX1__Program_Category__c",
    /** Human-readable title, used for the item title and the URL path part. */
    trNameField: "Name",
    zestyTitleField: "category_name",
    /**
     * Fields pulled into the snapshot. Keep this list explicit: Program
     * Category is mostly check-in kiosk configuration and almost none of it
     * belongs on a website.
     */
    trFields: [
      "Id",
      "Name",
      "TREX1__Available__c",
      "TREX1__Available_Online__c",
      "TREX1__Description_Rich_Text__c",
      "LastModifiedDate",
      "SystemModstamp"
    ],
    /** No WHERE clause: all 9 rows sync, availability is a render-time call. */
    where: null,
    /**
     * Zesty field <- Traction Rec snapshot key, applied ON CREATE ONLY.
     * Nothing aligns here beyond the name: Program Category's rich-text
     * description is empty on all 9 records, so `card_summary`,
     * `intro_content` and `hero_subtitle` have no source and stay editorial.
     */
    zestyFieldsFromTr: {},
    /** Parent link, filled by the reconciler from the tier above. */
    parentTier: null
  },

  programs: {
    label: "Program",
    zestyModel: "programs",
    trObject: "TREX1__Program__c",
    trNameField: "Name",
    zestyTitleField: "program_name",
    trFields: [
      "Id",
      "Name",
      "TREX1__Available__c",
      "TREX1__Available_Online__c",
      "TREX1__Description__c",
      "LastModifiedDate",
      "SystemModstamp"
    ],
    where: null,
    /** Program's two description fields are empty on all 22 records. */
    zestyFieldsFromTr: {},
    parentTier: "program_categories",
    /** One-to-many field on the Zesty model, seeded on create only. */
    zestyParentField: "categories",
    /**
     * The ONE key this service adds that Salesforce does not return.
     *
     * A Program record has no category field — the link lives in the
     * `TREX1__Program_Category_Tag__c` junction — so it has to be attached
     * here. It is named after the junction's own lookup field, so it still
     * reads as Traction Rec's vocabulary rather than ours.
     *
     * Courses and Classes need nothing added: their parent is already in the
     * record Salesforce returns (`TREX1__Program__c`, and
     * `TREX1__cso_Course_Session__r.TREX1__Course__c`).
     */
    relationKey: "TREX1__Program_Category__c",
    /**
     * Category <-> Program is a junction object, not a lookup, so the parent
     * link is resolved by a second query rather than a field on the record.
     */
    parentVia: {
      junction: "TREX1__Program_Category_Tag__c",
      childField: "TREX1__Program__c",
      parentField: "TREX1__Program_Category__c"
    }
  },

  courses: {
    label: "Course",
    zestyModel: "courses",
    trObject: "TREX1__Course__c",
    trNameField: "Name",
    zestyTitleField: "course_name",
    trFields: [
      "Id",
      "Name",
      "TREX1__Program__c",
      "TREX1__Available__c",
      "TREX1__Available_Online__c",
      "TREX1__Description__c",
      "TREX1__Rich_Description__c",
      "LastModifiedDate",
      "SystemModstamp"
    ],
    where: null,
    /** Course is the first tier with real copy: 63/119 have a rich description. */
    zestyFieldsFromTr: {
      description: (tr) => tr.TREX1__Rich_Description__c || tr.TREX1__Description__c
    },
    parentTier: "programs",
    zestyParentField: "programs",
    parentVia: { lookup: "TREX1__Program__c" }
  },

  classes: {
    label: "Class",
    zestyModel: "classes",
    /**
     * The leaf is the junction row, not Course Option: it is what carries the
     * publishing gate and the registration deep link, and a Course Option can
     * appear under more than one Course Session.
     */
    trObject: "TREX1__Course_Session_Option__c",
    trNameField: "TREX1__Course_Option__r.Name",
    zestyTitleField: "class_name",
    /**
     * Plain SOQL paths. Salesforce's own field names are the published keys —
     * see the note on `relationKey` below.
     */
    trFields: [
      "Id",
      "TREX1__Course_Online_Availability__c",
      "Deep_Link_URL__c",
      "TREX1__Available_Online__c",
      "TREX1__Option_Available__c",
      "LastModifiedDate",
      "SystemModstamp",

      // Course Session -> Course, for the parent link and the season
      "TREX1__cso_Course_Session__c",
      "TREX1__cso_Course_Session__r.Name",
      "TREX1__cso_Course_Session__r.TREX1__Course__c",
      "TREX1__cso_Course_Session__r.TREX1__Session__r.Name",

      // Course Option: the bookable unit
      "TREX1__Course_Option__c",
      "TREX1__Course_Option__r.Name",
      "TREX1__Course_Option__r.TREX1__Start_Date__c",
      "TREX1__Course_Option__r.TREX1__End_Date__c",
      // Multipicklist: 65% of options are multi-day ("Tuesday;Thursday").
      "TREX1__Course_Option__r.TREX1__Day_of_Week__c",
      // The raw time fields are strings and inconsistently formatted; the
      // formula fields normalise to "18:00:00.000".
      "TREX1__Course_Option__r.TREX1__Start_Time_Formula__c",
      "TREX1__Course_Option__r.TREX1__End_Time_Formula__c",
      "TREX1__Course_Option__r.TREX1__Age_Min__c",
      "TREX1__Course_Option__r.TREX1__Age_Max__c",
      // Free text, inconsistent, populated on ~a third of options.
      "TREX1__Course_Option__r.TREX1__Instructor__c",
      "TREX1__Course_Option__r.TREX1__Capacity__c",
      "TREX1__Course_Option__r.TREX1__Registration_Total__c",
      // The formula field, populated 945/945. There is no
      // `Available_Capacity__c` on this object.
      "TREX1__Course_Option__r.TREX1__Total_Capacity_Available__c",
      "TREX1__Course_Option__r.TREX1__Unlimited_Capacity__c",
      // TR's own directive for whether a spot count may be shown publicly.
      "TREX1__Course_Option__r.TREX1__Show_Capacity_Online__c",
      "TREX1__Course_Option__r.TREX1__Waitlist_Total__c",
      "TREX1__Course_Option__r.TREX1__Waitlist_Capacity__c",
      "TREX1__Course_Option__r.TREX1__Description__c",
      "TREX1__Course_Option__r.TREX1__Product__c"
    ],
    where: "TREX1__Course_Online_Availability__c = null",
    /**
     * The class tier is where the two models overlap most. These are seeded on
     * create so an item is useful immediately; after that the snapshot is the
     * live source and these fields are the editor's to override.
     */
    zestyFieldsFromTr: {
      class_start_date: (tr) => at(tr, `${OPT}.TREX1__Start_Date__c`),
      class_end_date: (tr) => at(tr, `${OPT}.TREX1__End_Date__c`),
      day_of_week: (tr) => singleDayOrBlank(at(tr, `${OPT}.TREX1__Day_of_Week__c`)),
      time: (tr) =>
        joinRange(
          to12Hour(trimSeconds(at(tr, `${OPT}.TREX1__Start_Time_Formula__c`))),
          to12Hour(trimSeconds(at(tr, `${OPT}.TREX1__End_Time_Formula__c`))),
          " \u2013 "
        ),
      age_range: (tr) =>
        joinRange(at(tr, `${OPT}.TREX1__Age_Min__c`), at(tr, `${OPT}.TREX1__Age_Max__c`), " to ", "Ages "),
      instructors: (tr) => at(tr, `${OPT}.TREX1__Instructor__c`),
      deep_link_url: "Deep_Link_URL__c",
      spots_remaining: (tr) => at(tr, `${OPT}.TREX1__Total_Capacity_Available__c`),
      enrollment_status: (tr) => enrollmentStatus(tr),
      member_price: (tr, snapshot) => priceOfType(snapshot, "Member"),
      public_price: (tr, snapshot) => priceOfType(snapshot, "Non-Member"),
      description: (tr) => at(tr, `${OPT}.TREX1__Description__c`)
      // facility_location has no Traction Rec source — no Location object is
      // exposed in this org at all. It stays editorial.
    },
    parentTier: "courses",
    zestyParentField: "courses",
    parentVia: { lookup: "TREX1__cso_Course_Session__r.TREX1__Course__c" },
    /** Price is a second hop: Course Option -> Product -> Price Level. */
    priceJoin: {
      /** Where the record's Product id is. */
      productPath: "TREX1__Course_Option__r.TREX1__Product__c",
      object: "TREX1__Price_Level__c",
      productField: "TREX1__Product__c",
      amountField: "TREX1__Total_Billing_Schedule_Amount__c",
      fields: [
        "Id",
        "Name",
        "TREX1__Product__c",
        "TREX1__Total_Billing_Schedule_Amount__c",
        "TREX1__Initial_Fee_Amount__c",
        // Member / Non-Member. Verified: on class price levels this
        // is populated and pairs cleanly (24 Member / 25 Non-Member across the
        // publishable set), so the card can label both rather than guess.
        "TREX1__Price_Type__c"
      ]
    }
  },

  /**
   * Memberships are FILES ONLY: no Zesty model, no items.
   * Nothing in the design gives a membership its own page; the Membership and
   * Day Pass pages show them as cards in [membership_tiers] / [day_pass_passes],
   * whose rows point at a membership type by its Traction Rec id.
   *
   * Out of Traction Rec's catalog document, but verified in the org
   * (KROC-draft/tractionrec-sandbox-content-model.md §8.12–8.13).
   */
  membership_categories: {
    label: "Membership Category",
    filesOnly: true,
    trObject: "TREX1__Membership_Category__c",
    trNameField: "Name",
    trFields: [
      "Id",
      "Name",
      "TREX1__Available_Online__c",
      "TREX1__Available_For_Purchase__c",
      "TREX1__Category_Description__c",
      "TREX1__Display_Order__c",
      "LastModifiedDate",
      "SystemModstamp"
    ],
    /**
     * The publishing gate. 10 of 17 categories are staff, insurance, employee
     * or front-desk-only, and the website only sells what Traction Rec sells
     * online.
     */
    where: "TREX1__Available_Online__c = true AND TREX1__Available_For_Purchase__c = true",
    parentTier: null
  },

  membership_types: {
    label: "Membership Type",
    filesOnly: true,
    trObject: "TREX1__Membership_Type__c",
    trNameField: "Name",
    trFields: [
      "Id",
      "Name",
      "TREX1__Category__c",
      "TREX1__Available_Online__c",
      "TREX1__Available_For_Purchase__c",
      "TREX1__Description__c",
      // The short audience label ("Adult", "Senior"). Set on individual types,
      // empty on family ones and on Teen Day Pass.
      "TREX1__Age_Range_Name__c",
      "TREX1__Min_Age__c",
      "TREX1__Max_Age__c",
      // Term: "12 Monthly", "1 Daily". Fixed Length · Fixed Term · Perpetual.
      "TREX1__Term_Length__c",
      "TREX1__Term_Type__c",
      "TREX1__End_Date_Setting__c",
      "TREX1__Fixed_Term_Start_Date__c",
      "TREX1__Fixed_Term_End_Date__c",
      // Household rules on family types: "2 Adult 18-110 + 4 Youth 0-17".
      "TREX1__Is_Group__c",
      "TREX1__Group_1_Name__c",
      "TREX1__Group_1_Plural_Name__c",
      "TREX1__Group_1_Min_Age__c",
      "TREX1__Group_1_Max_Age__c",
      "TREX1__Group_1_Max_Allowed__c",
      "TREX1__Group_2_Name__c",
      "TREX1__Group_2_Plural_Name__c",
      "TREX1__Group_2_Min_Age__c",
      "TREX1__Group_2_Max_Age__c",
      "TREX1__Group_2_Max_Allowed__c",
      "TREX1__Group_3_Name__c",
      "TREX1__Group_3_Plural_Name__c",
      "TREX1__Group_3_Min_Age__c",
      "TREX1__Group_3_Max_Age__c",
      "TREX1__Group_3_Max_Allowed__c",
      "TREX1__Product__c",
      // Pre-rendered and inconsistently ordered ("$46.00 a Month (Plus
      // one-time $20 Reg. Fee)"). The only place the registration fee appears;
      // a fallback, never the price itself.
      "TREX1__Product__r.TREX1__Price_Description__c",
      "LastModifiedDate",
      "SystemModstamp"
    ],
    /**
     * Both levels of the gate. A type's own online flag is not enough: Private
     * Music Lessons and Employee Personal Training types are flagged online
     * inside categories that are not.
     */
    where:
      "TREX1__Available_Online__c = true AND TREX1__Available_For_Purchase__c = true" +
      " AND TREX1__Category__r.TREX1__Available_Online__c = true" +
      " AND TREX1__Category__r.TREX1__Available_For_Purchase__c = true",
    parentTier: "membership_categories",
    parentVia: { lookup: "TREX1__Category__c" },
    /**
     * Membership Type -> Product -> Price Level -> Planned Billing Schedule.
     * Where the real amount sits depends on the kind:
     *
     *   one-time (Annual, 1 Month)  schedule Amount, Term Type "One Time"
     *   Autopay                     schedule Amount, Term Type "Monthly"
     *                               (the level's total is a year's worth)
     *   Day Pass                    level Initial_Fee_Amount; no schedule,
     *                               and the level's total is $0
     *
     * so both hops are carried and the site picks.
     */
    priceJoin: {
      productPath: "TREX1__Product__c",
      object: "TREX1__Price_Level__c",
      productField: "TREX1__Product__c",
      amountField: "TREX1__Total_Billing_Schedule_Amount__c",
      fields: [
        "Id",
        "Name",
        "TREX1__Product__c",
        "TREX1__Total_Billing_Schedule_Amount__c",
        "TREX1__Initial_Fee_Amount__c",
        "TREX1__Price_Type__c"
      ],
      schedules: {
        object: "TREX1__Planned_Billing_Schedule__c",
        levelField: "TREX1__Price_Level__c",
        fields: [
          "Id",
          "Name",
          "TREX1__Price_Level__c",
          "TREX1__Term_Type__c",
          "TREX1__Amount__c",
          "TREX1__Total_Billing_Amount__c",
          "TREX1__Number_Of_Terms__c"
        ]
      }
    }
  }
};

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

function load() {
  const tiers = (process.env.SYNC_TIERS || Object.keys(TIERS).join(","))
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  for (const t of tiers) {
    if (!TIERS[t]) {
      throw new Error(`Unknown tier "${t}". Known tiers: ${Object.keys(TIERS).join(", ")}`);
    }
  }

  // SEED_TEMPLATE_ITEMS=program_categories:7-abc…,courses:7-def…
  const seedTemplates = {};
  for (const pair of (process.env.SEED_TEMPLATE_ITEMS || "").split(",")) {
    const [tier, zuid] = pair.split(":").map((x) => (x || "").trim());
    if (tier && zuid) {
      seedTemplates[tier] = zuid;
    }
  }

  return {
    tiers,
    seedTemplates,
    dryRun: bool(process.env.DRY_RUN, true),
    createMissingItems: bool(process.env.CREATE_MISSING_ITEMS, true),
    triggerKey: process.env.SYNC_TRIGGER_KEY || "",

    tr: {
      loginUrl: required("TR_LOGIN_URL").replace(/\/+$/, ""),
      apiVersion: process.env.TR_API_VERSION || "v62.0",
      clientId: required("TR_CLIENT_ID"),
      clientSecret: required("TR_CLIENT_SECRET")
    },

    zesty: {
      instanceZuid: required("ZESTY_INSTANCE_ZUID"),
      token: process.env.ZESTY_INSTANCE_TOKEN || "",
      email: process.env.ZESTY_USER_EMAIL || "",
      password: process.env.ZESTY_USER_PASSWORD || ""
    }
  };
}

module.exports = { load, TIERS, SNAPSHOT_ROOT, STATE_FILE, TR_ID_FIELD };
