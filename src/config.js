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
 * always survives in the snapshot's `daysOfWeek`, which is what a template
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
  if (tr.unlimitedCapacity) {
    return "open";
  }
  const spots = Number(tr.spotsRemaining);
  if (!Number.isFinite(spots)) {
    return "";
  }
  if (spots > 0) {
    return "open";
  }
  const capacity = Number(tr.waitlistCapacity);
  const taken = Number(tr.waitlistTotal) || 0;
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
 * The LEADING SLASH is load-bearing. Verified 2026-09-25: every ajax-json view
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
  program_category: {
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

  program: {
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
    parentTier: "program_category",
    /** One-to-many field on the Zesty model, seeded on create only. */
    zestyParentField: "categories",
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

  course: {
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
      description: (tr) => tr.richDescription || tr.description
    },
    parentTier: "program",
    zestyParentField: "programs",
    parentVia: { lookup: "TREX1__Program__c" }
  },

  class: {
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
     * `[soqlPath, outputKey]` where the derived name would read badly. The
     * output key is what the front end sees in the snapshot's `data` object.
     */
    trFields: [
      "Id",
      ["TREX1__Course_Online_Availability__c", "blockingReasons"],
      ["Deep_Link_URL__c", "registerUrl"],
      ["TREX1__Available_Online__c", "availableOnline"],
      ["TREX1__Option_Available__c", "optionAvailable"],
      "LastModifiedDate",
      "SystemModstamp",

      // Course Session -> Course, for the parent link and the season
      ["TREX1__cso_Course_Session__c", "courseSessionId"],
      ["TREX1__cso_Course_Session__r.Name", "courseSessionName"],
      ["TREX1__cso_Course_Session__r.TREX1__Course__c", "courseId"],
      ["TREX1__cso_Course_Session__r.TREX1__Session__r.Name", "season"],

      // Course Option: the bookable unit
      ["TREX1__Course_Option__c", "courseOptionId"],
      ["TREX1__Course_Option__r.Name", "name"],
      ["TREX1__Course_Option__r.TREX1__Start_Date__c", "startDate"],
      ["TREX1__Course_Option__r.TREX1__End_Date__c", "endDate"],
      // Multipicklist: 65% of options are multi-day ("Tuesday;Thursday").
      ["TREX1__Course_Option__r.TREX1__Day_of_Week__c", "daysOfWeek"],
      // The raw time fields are strings and inconsistently formatted; the
      // formula fields normalise to "18:00:00.000".
      ["TREX1__Course_Option__r.TREX1__Start_Time_Formula__c", "startTime"],
      ["TREX1__Course_Option__r.TREX1__End_Time_Formula__c", "endTime"],
      ["TREX1__Course_Option__r.TREX1__Age_Min__c", "ageMin"],
      ["TREX1__Course_Option__r.TREX1__Age_Max__c", "ageMax"],
      // Free text, inconsistent, populated on ~a third of options.
      ["TREX1__Course_Option__r.TREX1__Instructor__c", "instructor"],
      ["TREX1__Course_Option__r.TREX1__Capacity__c", "capacity"],
      ["TREX1__Course_Option__r.TREX1__Registration_Total__c", "registered"],
      // The formula field, populated 945/945. There is no
      // `Available_Capacity__c` on this object.
      ["TREX1__Course_Option__r.TREX1__Total_Capacity_Available__c", "spotsRemaining"],
      ["TREX1__Course_Option__r.TREX1__Unlimited_Capacity__c", "unlimitedCapacity"],
      // TR's own directive for whether a spot count may be shown publicly.
      ["TREX1__Course_Option__r.TREX1__Show_Capacity_Online__c", "showCapacityOnline"],
      ["TREX1__Course_Option__r.TREX1__Waitlist_Total__c", "waitlistTotal"],
      ["TREX1__Course_Option__r.TREX1__Waitlist_Capacity__c", "waitlistCapacity"],
      ["TREX1__Course_Option__r.TREX1__Description__c", "description"],
      ["TREX1__Course_Option__r.TREX1__Product__c", "productId"]
    ],
    where: "TREX1__Course_Online_Availability__c = null",
    /**
     * The class tier is where the two models overlap most. These are seeded on
     * create so an item is useful immediately; after that the snapshot is the
     * live source and these fields are the editor's to override.
     */
    zestyFieldsFromTr: {
      class_start_date: "startDate",
      class_end_date: "endDate",
      day_of_week: (tr) => singleDayOrBlank(tr.daysOfWeek),
      time: (tr) => joinRange(to12Hour(trimSeconds(tr.startTime)), to12Hour(trimSeconds(tr.endTime)), " \u2013 "),
      age_range: (tr) => joinRange(tr.ageMin, tr.ageMax, " to ", "Ages "),
      instructors: "instructor",
      deep_link_url: "registerUrl",
      spots_remaining: "spotsRemaining",
      enrollment_status: (tr) => enrollmentStatus(tr),
      member_price: (tr, snapshot) => priceOfType(snapshot, "Member"),
      public_price: (tr, snapshot) => priceOfType(snapshot, "Non-Member"),
      description: "description"
      // facility_location has no Traction Rec source — no Location object is
      // exposed in this org at all. It stays editorial.
    },
    parentTier: "course",
    zestyParentField: "courses",
    parentVia: { lookup: "TREX1__cso_Course_Session__r.TREX1__Course__c" },
    /** Price is a second hop: Course Option -> Product -> Price Level. */
    priceJoin: {
      object: "TREX1__Price_Level__c",
      productField: "TREX1__Product__c",
      amountField: "TREX1__Total_Billing_Schedule_Amount__c",
      fields: [
        "Id",
        "Name",
        "TREX1__Product__c",
        "TREX1__Total_Billing_Schedule_Amount__c",
        "TREX1__Initial_Fee_Amount__c",
        // Member / Non-Member. Verified 2026-09-28: on class price levels this
        // is populated and pairs cleanly (24 Member / 25 Non-Member across the
        // publishable set), so the card can label both rather than guess.
        "TREX1__Price_Type__c"
      ]
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

  // SEED_TEMPLATE_ITEMS=program_category:7-abc…,course:7-def…
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
