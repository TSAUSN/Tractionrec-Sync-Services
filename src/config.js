"use strict";

/**
 * Configuration and the Traction Rec tier map: which object each tier reads,
 * which fields, through which publishing gate, and how its parent and price
 * are reached. The dataset sync (src/datasets/) maps these records onto the
 * tr_* Zesty datasets; this file only says what to query.
 *
 * Field names are verified against the org, not assumed
 * (KROC-draft/tractionrec-sandbox-content-model.md).
 */

const OPT = "TREX1__Course_Option__r";

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : v === "1" || v === "true");

const TIERS = {
  program_categories: {
    label: "Program Category",
    trObject: "TREX1__Program_Category__c",
    /**
     * Keep this list explicit: Program Category is mostly check-in kiosk
     * configuration and almost none of it belongs on a website.
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
    /** No gate: all rows sync, availability is a render-time call. */
    where: null
  },

  programs: {
    label: "Program",
    trObject: "TREX1__Program__c",
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
    /**
     * A Program record has no category field: Category <-> Program is the
     * TREX1__Program_Category_Tag__c junction (many-to-many), read by a second
     * query in fetchTier.
     */
    parentVia: {
      junction: "TREX1__Program_Category_Tag__c",
      childField: "TREX1__Program__c",
      parentField: "TREX1__Program_Category__c"
    }
  },

  courses: {
    label: "Course",
    trObject: "TREX1__Course__c",
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
    parentVia: { lookup: "TREX1__Program__c" }
  },

  classes: {
    label: "Class",
    /**
     * The leaf is the junction row, not Course Option: it is what carries the
     * publishing gate and the registration deep link.
     */
    trObject: "TREX1__Course_Session_Option__c",
    trFields: [
      "Id",
      "TREX1__Course_Online_Availability__c",
      "Deep_Link_URL__c",
      "TREX1__Available_Online__c",
      "TREX1__Option_Available__c",
      "LastModifiedDate",
      "SystemModstamp",

      "TREX1__cso_Course_Session__c",
      "TREX1__cso_Course_Session__r.Name",
      "TREX1__cso_Course_Session__r.TREX1__Course__c",
      "TREX1__cso_Course_Session__r.TREX1__Session__r.Name",

      "TREX1__Course_Option__c",
      `${OPT}.Name`,
      `${OPT}.TREX1__Start_Date__c`,
      `${OPT}.TREX1__End_Date__c`,
      `${OPT}.TREX1__Day_of_Week__c`,
      `${OPT}.TREX1__Start_Time_Formula__c`,
      `${OPT}.TREX1__End_Time_Formula__c`,
      `${OPT}.TREX1__Age_Min__c`,
      `${OPT}.TREX1__Age_Max__c`,
      `${OPT}.TREX1__Instructor__c`,
      `${OPT}.TREX1__Capacity__c`,
      `${OPT}.TREX1__Registration_Total__c`,
      `${OPT}.TREX1__Total_Capacity_Available__c`,
      `${OPT}.TREX1__Unlimited_Capacity__c`,
      `${OPT}.TREX1__Show_Capacity_Online__c`,
      `${OPT}.TREX1__Waitlist_Total__c`,
      `${OPT}.TREX1__Waitlist_Capacity__c`,
      `${OPT}.TREX1__Description__c`,
      `${OPT}.TREX1__Product__c`
    ],
    /**
     * The publishing gate. TREX1__Course_Online_Availability__c is a FORMULA:
     * empty means "registrable online now", otherwise it lists why not
     * ("Outside Course Option Registration Timeframe", "Course Session Option
     * Not Available", …). It is time-based — a class leaves the gate when its
     * registration window closes, and enters it when one opens, without the
     * record being modified (verified 2026-10-29). So the gate is re-read in
     * full on every run, never incrementally.
     */
    where: "TREX1__Course_Online_Availability__c = null",
    /** The reason a class is outside the gate, stored as its inactive_reason. */
    gateReasonField: "TREX1__Course_Online_Availability__c",
    parentVia: { lookup: "TREX1__cso_Course_Session__r.TREX1__Course__c" },
    /**
     * Price is a second hop: Course Option -> Product -> Price Level. Course
     * Option's Product is authoritative; Course Session's is a per-facility
     * "<Facility> Free Product" placeholder with no price.
     */
    priceJoin: {
      productPath: `${OPT}.TREX1__Product__c`,
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
      ]
    }
  },

  membership_categories: {
    label: "Membership Category",
    trObject: "TREX1__Membership_Category__c",
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
     * or front-desk-only; the website only sells what Traction Rec sells online.
     */
    where: "TREX1__Available_Online__c = true AND TREX1__Available_For_Purchase__c = true"
  },

  membership_types: {
    label: "Membership Type",
    trObject: "TREX1__Membership_Type__c",
    trFields: [
      "Id",
      "Name",
      "TREX1__Category__c",
      "TREX1__Category__r.TREX1__Available_Online__c",
      "TREX1__Category__r.TREX1__Available_For_Purchase__c",
      "TREX1__Available_Online__c",
      "TREX1__Available_For_Purchase__c",
      "TREX1__Description__c",
      "TREX1__Age_Range_Name__c",
      "TREX1__Min_Age__c",
      "TREX1__Max_Age__c",
      "TREX1__Term_Length__c",
      "TREX1__Term_Type__c",
      "TREX1__End_Date_Setting__c",
      "TREX1__Fixed_Term_Start_Date__c",
      "TREX1__Fixed_Term_End_Date__c",
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
    parentVia: { lookup: "TREX1__Category__c" },
    /**
     * Membership Type -> Product -> Price Level -> Planned Billing Schedule.
     * Where the real amount sits depends on the kind (verified 2026-10-08):
     * Autopay = the Monthly schedule's amount; Annual / 1 Month = the One Time
     * schedule's amount; Day Pass = the level's initial fee (no schedule).
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
  return {
    dryRun: bool(process.env.DRY_RUN, true),
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

module.exports = { load, TIERS };
