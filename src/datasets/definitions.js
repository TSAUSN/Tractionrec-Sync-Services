"use strict";

/**
 * The dataset sync's map: which Traction Rec records become items of which
 * Zesty dataset, and where each field's value comes from.
 *
 * Field TYPES are not repeated here. They live in zesty-models/*.json, the
 * specs the models were created from (docs/dataset-storage.md), and
 * schema.js checks the live models against those specs before a run writes
 * anything. This file only says where each value comes from.
 *
 * Order matters: a relation needs its target's ZUID, so a dataset comes
 * after every dataset it points at. It is the same order as the spec files.
 *
 * Every dataset gets `tractionrec_id`, `name`, `active`, `inactive_reason`,
 * `last_modified_date`, `system_modstamp`, `sync_hash` and `synced_at` from
 * plan.js, so they are not listed below.
 *
 * Lifecycle: a record is never deleted. One that leaves
 * Traction Rec's published set, is removed, or loses its parent becomes
 * `active = 0` with a reason, and the site hides it.
 *   tier         the TIERS key (src/config.js) a record of this dataset is
 *                re-read from by Id when it leaves the published set, to get
 *                its current values and the reason
 *   gateReason   why a re-read record is outside the published set
 *   derived      products / price levels / schedules: in the set only while
 *                a published class or membership type uses them, so leaving
 *                it is not a Traction Rec change and nothing is re-read
 *   page         catalog datasets own a Zesty page per record: the page model,
 *                its title field, and the dataset whose page is the parent
 */

const { pluck } = require("../tractionrec/fetch-tier");

const OPT = "TREX1__Course_Option__r";
const SES = "TREX1__cso_Course_Session__r";

/** A value getter for a dotted Salesforce path. */
const at = (path) => (record) => pluck(record, path);

// "Outside Course Option Registration Timeframe |" -> the reasons, joined.
const formulaReason = (value) =>
  String(value || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ");

// Why a membership category / type is not sold online, from its own flags.
const notSoldReason = (r, ownLabel) => {
  const reasons = [];
  if (r.TREX1__Available_Online__c === false) {
    reasons.push(`${ownLabel} not available online`);
  }
  if (r.TREX1__Available_For_Purchase__c === false) {
    reasons.push(`${ownLabel} not available for purchase`);
  }
  const cat = r.TREX1__Category__r;
  if (cat && cat.TREX1__Available_Online__c === false) {
    reasons.push("Its category not available online");
  }
  if (cat && cat.TREX1__Available_For_Purchase__c === false) {
    reasons.push("Its category not available for purchase");
  }
  return reasons.join("; ");
};

const DERIVED_REASON = "No longer used by a published class or membership type";

const DATASETS = [
  {
    key: "tr_program_categories",
    tier: "program_categories",
    page: { model: "categories", titleField: "category_name" },
    source: (tr) => tr.program_categories.records,
    name: at("Name"),
    fields: {
      available: at("TREX1__Available__c"),
      available_online: at("TREX1__Available_Online__c"),
      description_rich_text: at("TREX1__Description_Rich_Text__c")
    },
    relations: {
      page: { pageModel: "categories" }
    }
  },
  {
    key: "tr_programs",
    tier: "programs",
    page: { model: "programs", titleField: "program_name", parent: "program_categories" },
    source: (tr) => tr.programs.records,
    name: at("Name"),
    fields: {
      available: at("TREX1__Available__c"),
      available_online: at("TREX1__Available_Online__c"),
      description: at("TREX1__Description__c")
    },
    relations: {
      page: { pageModel: "programs" },
      // Many-to-many through TREX1__Program_Category_Tag__c (fetchTier's junction
      // query). A program with no tag is skipped, as the file sync does.
      program_categories: {
        dataset: "tr_program_categories",
        ids: (record, tr) => tr.programs.extras.parentByChild?.get(record.Id) || [],
        required: true
      }
    }
  },
  {
    key: "tr_courses",
    tier: "courses",
    page: { model: "courses", titleField: "course_name", parent: "program" },
    source: (tr) => tr.courses.records,
    name: at("Name"),
    fields: {
      available: at("TREX1__Available__c"),
      available_online: at("TREX1__Available_Online__c"),
      description: at("TREX1__Description__c"),
      rich_description: at("TREX1__Rich_Description__c")
    },
    relations: {
      page: { pageModel: "courses" },
      program: { dataset: "tr_programs", ids: (r) => [r.TREX1__Program__c], required: true }
    }
  },
  {
    key: "tr_products",
    derived: true,
    source: (tr) => tr.products,
    name: at("Name"),
    fields: {
      price_description: at("TREX1__Price_Description__c")
    },
    relations: {}
  },
  {
    key: "tr_price_levels",
    derived: true,
    source: (tr) => tr.priceLevels,
    name: at("Name"),
    fields: {
      price_type: at("TREX1__Price_Type__c"),
      amount: at("TREX1__Total_Billing_Schedule_Amount__c"),
      initial_fee: at("TREX1__Initial_Fee_Amount__c")
    },
    relations: {
      product: { dataset: "tr_products", ids: (r) => [r.TREX1__Product__c], required: true }
    }
  },
  {
    key: "tr_billing_schedules",
    derived: true,
    source: (tr) => tr.billingSchedules,
    name: at("Name"),
    fields: {
      term_type: at("TREX1__Term_Type__c"),
      amount: at("TREX1__Amount__c"),
      total_amount: at("TREX1__Total_Billing_Amount__c"),
      number_of_terms: at("TREX1__Number_Of_Terms__c")
    },
    relations: {
      price_level: { dataset: "tr_price_levels", ids: (r) => [r.TREX1__Price_Level__c], required: true }
    }
  },
  {
    // The Course Session Option junction row, with its Course Option (1:1 with
    // the class) and the Course Session's name and season flattened in.
    key: "tr_classes",
    tier: "classes",
    gateReason: (r) => formulaReason(r.TREX1__Course_Online_Availability__c),
    page: { model: "classes", titleField: "class_name", parent: "course" },
    source: (tr) => tr.classes.records,
    name: (r) => pluck(r, `${OPT}.Name`) || r.Id,
    fields: {
      deep_link_url: at("Deep_Link_URL__c"),
      available_online: at("TREX1__Available_Online__c"),
      option_available: at("TREX1__Option_Available__c"),
      course_session_id: at("TREX1__cso_Course_Session__c"),
      course_session_name: at(`${SES}.Name`),
      season: at(`${SES}.TREX1__Session__r.Name`),
      course_option_id: at("TREX1__Course_Option__c"),
      start_date: at(`${OPT}.TREX1__Start_Date__c`),
      end_date: at(`${OPT}.TREX1__End_Date__c`),
      day_of_week: at(`${OPT}.TREX1__Day_of_Week__c`),
      start_time: at(`${OPT}.TREX1__Start_Time_Formula__c`),
      end_time: at(`${OPT}.TREX1__End_Time_Formula__c`),
      age_min: at(`${OPT}.TREX1__Age_Min__c`),
      age_max: at(`${OPT}.TREX1__Age_Max__c`),
      instructor: at(`${OPT}.TREX1__Instructor__c`),
      capacity: at(`${OPT}.TREX1__Capacity__c`),
      registration_total: at(`${OPT}.TREX1__Registration_Total__c`),
      capacity_available: at(`${OPT}.TREX1__Total_Capacity_Available__c`),
      unlimited_capacity: at(`${OPT}.TREX1__Unlimited_Capacity__c`),
      show_capacity_online: at(`${OPT}.TREX1__Show_Capacity_Online__c`),
      waitlist_total: at(`${OPT}.TREX1__Waitlist_Total__c`),
      waitlist_capacity: at(`${OPT}.TREX1__Waitlist_Capacity__c`),
      description: at(`${OPT}.TREX1__Description__c`)
    },
    relations: {
      page: { pageModel: "classes" },
      course: { dataset: "tr_courses", ids: (r) => [pluck(r, `${SES}.TREX1__Course__c`)], required: true },
      product: { dataset: "tr_products", ids: (r) => [pluck(r, `${OPT}.TREX1__Product__c`)] }
    }
  },
  {
    key: "tr_membership_categories",
    tier: "membership_categories",
    gateReason: (r) => notSoldReason(r, "Category"),
    source: (tr) => tr.membership_categories.records,
    name: at("Name"),
    fields: {
      available_online: at("TREX1__Available_Online__c"),
      available_for_purchase: at("TREX1__Available_For_Purchase__c"),
      category_description: at("TREX1__Category_Description__c"),
      display_order: at("TREX1__Display_Order__c")
    },
    relations: {}
  },
  {
    key: "tr_membership_types",
    tier: "membership_types",
    gateReason: (r) => notSoldReason(r, "Type"),
    source: (tr) => tr.membership_types.records,
    name: at("Name"),
    fields: {
      available_online: at("TREX1__Available_Online__c"),
      available_for_purchase: at("TREX1__Available_For_Purchase__c"),
      description: at("TREX1__Description__c"),
      age_range_name: at("TREX1__Age_Range_Name__c"),
      min_age: at("TREX1__Min_Age__c"),
      max_age: at("TREX1__Max_Age__c"),
      term_length: at("TREX1__Term_Length__c"),
      term_type: at("TREX1__Term_Type__c"),
      end_date_setting: at("TREX1__End_Date_Setting__c"),
      fixed_term_start_date: at("TREX1__Fixed_Term_Start_Date__c"),
      fixed_term_end_date: at("TREX1__Fixed_Term_End_Date__c"),
      is_group: at("TREX1__Is_Group__c"),
      ...Object.fromEntries(
        [1, 2, 3].flatMap((n) => [
          [`group_${n}_name`, at(`TREX1__Group_${n}_Name__c`)],
          [`group_${n}_plural_name`, at(`TREX1__Group_${n}_Plural_Name__c`)],
          [`group_${n}_min_age`, at(`TREX1__Group_${n}_Min_Age__c`)],
          [`group_${n}_max_age`, at(`TREX1__Group_${n}_Max_Age__c`)],
          [`group_${n}_max_allowed`, at(`TREX1__Group_${n}_Max_Allowed__c`)]
        ])
      )
    },
    relations: {
      category: { dataset: "tr_membership_categories", ids: (r) => [r.TREX1__Category__c], required: true },
      product: { dataset: "tr_products", ids: (r) => [r.TREX1__Product__c] }
    }
  }
];

/** Fields every dataset carries, filled by plan.js rather than a getter. */
const COMMON_FIELDS = [
  "tractionrec_id",
  "name",
  "active",
  "inactive_reason",
  "last_modified_date",
  "system_modstamp",
  "sync_hash",
  "synced_at"
];

const byKey = (key) => DATASETS.find((d) => d.key === key);

module.exports = { DATASETS, COMMON_FIELDS, DERIVED_REASON, byKey, formulaReason };
