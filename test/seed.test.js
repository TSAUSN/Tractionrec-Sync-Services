"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { buildCreateData, unsatisfiedRequired } = require("../src/sync/seed");
const { TIERS } = require("../src/config");

const CATEGORY_REQUIRED = [
  "category_name",
  "category_icon",
  "hero_image_desktop",
  "hero_subtitle"
];

// The live `testtest` item on the instance, which is what makes creates possible
// until `required` is cleared on the editorial fields.
const TEMPLATE = {
  card_summary: "test",
  category_icon: "3-15a85ac1-wpxff1",
  category_name: "testtest",
  hero_image_desktop: "3-15a85ab2-jct8fv",
  hero_subtitle: "test",
  intro_content: "<p>test</p>",
  sort_order: 0,
  tractionrec_id: null
};

test("the template fills required fields the service cannot supply", () => {
  const { data, provenance } = buildCreateData({
    tier: TIERS.program_category,
    trId: "a2za6000000GGX4AAO",
    title: "Aquatics",
    snapshot: { data: { name: "Aquatics" } },
    requiredFields: CATEGORY_REQUIRED,
    templateData: TEMPLATE
  });

  assert.equal(data.tractionrec_id, "a2za6000000GGX4AAO");
  assert.equal(data.category_icon, "3-15a85ac1-wpxff1");
  assert.equal(data.hero_subtitle, "test");
  assert.deepEqual(unsatisfiedRequired(data, CATEGORY_REQUIRED), []);
  assert.deepEqual(provenance.template.sort(), [
    "category_icon",
    "hero_image_desktop",
    "hero_subtitle"
  ]);
});

test("the template never overwrites the real title", () => {
  const { data, provenance } = buildCreateData({
    tier: TIERS.program_category,
    trId: "a0A1",
    title: "Aquatics",
    snapshot: { data: {} },
    requiredFields: CATEGORY_REQUIRED,
    templateData: TEMPLATE
  });

  assert.equal(data.category_name, "Aquatics", "must not become 'testtest'");
  assert.ok(provenance.identity.includes("category_name"));
  assert.ok(!provenance.template.includes("category_name"));
});

test("the template is confined to required fields — optional ones stay empty", () => {
  const { data } = buildCreateData({
    tier: TIERS.program_category,
    trId: "a0A1",
    title: "Aquatics",
    snapshot: { data: {} },
    requiredFields: CATEGORY_REQUIRED,
    templateData: TEMPLATE
  });

  // card_summary, intro_content and sort_order are optional: copying "test"
  // into them would put machine content in fields editors own.
  assert.equal(data.card_summary, undefined);
  assert.equal(data.intro_content, undefined);
  assert.equal(data.sort_order, undefined);
});

test("Traction Rec data outranks the template when both could fill a field", () => {
  const tier = {
    ...TIERS.program_category,
    zestyFieldsFromTr: { hero_subtitle: "tagline" }
  };

  const { data, provenance } = buildCreateData({
    tier,
    trId: "a0A1",
    title: "Aquatics",
    snapshot: { data: { tagline: "Swim year round" } },
    requiredFields: CATEGORY_REQUIRED,
    templateData: TEMPLATE
  });

  assert.equal(data.hero_subtitle, "Swim year round");
  assert.ok(provenance.tractionrec.includes("hero_subtitle"));
  assert.ok(!provenance.template.includes("hero_subtitle"));
});

test("an empty Traction Rec value falls through to the template", () => {
  const tier = {
    ...TIERS.program_category,
    zestyFieldsFromTr: { hero_subtitle: "tagline" }
  };

  const { data, provenance } = buildCreateData({
    tier,
    trId: "a0A1",
    title: "Aquatics",
    // Program Category descriptions are empty on all 9 live records.
    snapshot: { data: { tagline: "" } },
    requiredFields: CATEGORY_REQUIRED,
    templateData: TEMPLATE
  });

  assert.equal(data.hero_subtitle, "test");
  assert.ok(provenance.template.includes("hero_subtitle"));
});

test("with no template, unsatisfied required fields are reported by name", () => {
  const { data } = buildCreateData({
    tier: TIERS.program_category,
    trId: "a0A1",
    title: "Aquatics",
    snapshot: { data: {} },
    requiredFields: CATEGORY_REQUIRED,
    templateData: null
  });

  assert.deepEqual(unsatisfiedRequired(data, CATEGORY_REQUIRED).sort(), [
    "category_icon",
    "hero_image_desktop",
    "hero_subtitle"
  ]);
});

test("class fields map from Traction Rec rather than from a placeholder", () => {
  const { data, provenance } = buildCreateData({
    tier: TIERS.class,
    trId: "a0X1",
    title: "Swim Level 2",
    parentItemZuid: "7-course",
    snapshot: {
      data: {
        startDate: "2026-09-08",
        endDate: "2026-10-27",
        daysOfWeek: "Tuesday;Thursday",
        startTime: "18:00:00.000",
        endTime: "19:30:00.000",
        ageMin: 5,
        ageMax: 12,
        instructor: "Malik Jones",
        registerUrl: "https://example.my.site.com/s/registration?a=1",
        spotsRemaining: 4
      }
    },
    requiredFields: ["class_name", "class_type", "hero_image_desktop"],
    templateData: { class_type: "Class", hero_image_desktop: "3-abc" }
  });

  assert.equal(data.class_name, "Swim Level 2");
  assert.equal(data.courses, "7-course");
  // Multi-day, so the single-day dropdown is left alone — see the test below.
  assert.equal(data.day_of_week, undefined);
  assert.equal(data.time, "6:00 PM – 7:30 PM");
  assert.equal(data.age_range, "Ages 5 to 12");
  assert.equal(data.deep_link_url, "https://example.my.site.com/s/registration?a=1");
  // class_type and the hero have no Traction Rec source, so they fall back.
  assert.deepEqual(provenance.template.sort(), ["class_type", "hero_image_desktop"]);
});

test("a multi-day class leaves the single-day dropdown empty", () => {
  // 65% of Course Options are multi-day and the Zesty dropdown only has
  // monday…sunday, so there is no value that means "Tuesday;Thursday".
  const { data } = buildCreateData({
    tier: TIERS.class,
    trId: "a0X1",
    title: "Swim Level 2",
    snapshot: { data: { daysOfWeek: "Tuesday;Thursday" } },
    requiredFields: [],
    templateData: null
  });
  assert.equal(data.day_of_week, undefined, "an invalid dropdown value must not be written");
});

test("a single-day class lowercases to match the dropdown's keys", () => {
  const { data } = buildCreateData({
    tier: TIERS.class,
    trId: "a0X1",
    title: "Swim Level 2",
    snapshot: { data: { daysOfWeek: "Thursday" } },
    requiredFields: [],
    templateData: null
  });
  assert.equal(data.day_of_week, "thursday");
});

test("member and non-member prices split out of the price-level array", () => {
  const { data } = buildCreateData({
    tier: TIERS.class,
    trId: "a0X1",
    title: "Foundational Piano",
    snapshot: {
      data: { spotsRemaining: 3 },
      prices: [
        { priceType: "Non-Member", amount: 80.5 },
        { priceType: "Member", amount: 68.42 }
      ]
    },
    requiredFields: [],
    templateData: null
  });

  assert.equal(data.member_price, 68.42);
  assert.equal(data.public_price, 80.5);
  assert.equal(data.enrollment_status, "open");
});

test("enrollment status distinguishes full from waitlist", () => {
  const status = (tr) =>
    buildCreateData({
      tier: TIERS.class,
      trId: "a0X1",
      title: "x",
      snapshot: { data: tr },
      requiredFields: [],
      templateData: null
    }).data.enrollment_status;

  assert.equal(status({ spotsRemaining: 4 }), "open");
  assert.equal(status({ spotsRemaining: 0, waitlistCapacity: 10, waitlistTotal: 2 }), "waitlist");
  assert.equal(status({ spotsRemaining: 0, waitlistCapacity: 10, waitlistTotal: 10 }), "full");
  assert.equal(status({ spotsRemaining: 0 }), "full");
  // No capacity figure at all is unknown, not "full".
  assert.equal(status({}), undefined);
});

test("items are not nested under their parent by default", () => {
  assert.ok(!TIERS.class.nestItemsUnderParent);
  assert.ok(!TIERS.course.nestItemsUnderParent);
  assert.ok(!TIERS.program.nestItemsUnderParent);
});
