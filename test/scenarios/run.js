"use strict";

/**
 * Scenario tests: the REAL sync against the REAL Zesty instance, with
 * Traction Rec simulated.
 *
 *   npm run test:scenarios
 *
 * Why simulated: the integration user is read-only on every TREX1 object, so
 * a test can't change Traction Rec. Instead the harness reads the real
 * published set once, adds a hand-written "SIMTEST" set (a program, two
 * courses, two classes, a product with prices, a membership type), and hands
 * the sync a source that serves that data. Each step changes the SIMTEST
 * records the way Traction Rec would, runs the sync live, and asserts what the
 * datasets, the page items and the stage pages show. Real records are served
 * exactly as Traction Rec has them, so they must stay unchanged throughout.
 *
 * It WRITES to the instance (allowed while testing): SIMTEST
 * dataset items and SIMTEST page items, which are published, so they show on
 * the stage site during the run. They are all deleted at the end (and at the
 * start, in case a previous run stopped half way), then one real sync run must
 * write nothing.
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const envPath = path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const { load } = require("../../src/config");
const { TractionRecClient } = require("../../src/tractionrec/client");
const { connect, ok } = require("../../src/zesty/client");
const { indexModels, indexItems } = require("../../src/zesty/items");
const { tractionRecSource } = require("../../src/datasets/fetch");
const { DATASETS } = require("../../src/datasets/definitions");
const { run } = require("../../src/datasets/run");

const SIM = "SIMTEST";
const STAGE = process.env.ZESTY_STAGE_URL || "https://6wz46m14-dev.webengine.zesty.io";
const PAGE_MODELS = ["categories", "programs", "courses", "classes"];
const STAMP = "2026-10-29T00:00:00.000+0000";

const ids = {
  program: `${SIM}PRG1`,
  course1: `${SIM}CRS1`,
  course2: `${SIM}CRS2`,
  class1: `${SIM}CLS1`,
  class2: `${SIM}CLS2`,
  product: `${SIM}PROD1`,
  member: `${SIM}LVLM`,
  nonMember: `${SIM}LVLN`,
  mtProduct: `${SIM}PROD2`,
  mtLevel: `${SIM}LVL2`,
  mtSchedule: `${SIM}SCH2`,
  mtype: `${SIM}MT1`
};

// --- the simulated Traction Rec ----------------------------------------------

const course = (Id, Name) => ({
  Id,
  Name,
  TREX1__Program__c: ids.program,
  TREX1__Available__c: true,
  TREX1__Available_Online__c: true,
  TREX1__Description__c: `${Name}: simulated for the sync scenario tests.`,
  TREX1__Rich_Description__c: null,
  LastModifiedDate: STAMP,
  SystemModstamp: STAMP
});

const cls = (Id, Name, courseId, startTime) => ({
  Id,
  TREX1__Course_Online_Availability__c: null,
  Deep_Link_URL__c: `https://example.org/register?sim=${Id}`,
  TREX1__Available_Online__c: true,
  TREX1__Option_Available__c: true,
  LastModifiedDate: STAMP,
  SystemModstamp: STAMP,
  TREX1__cso_Course_Session__c: `${Id}SES`,
  TREX1__cso_Course_Session__r: {
    Name: `${Name} session`,
    TREX1__Course__c: courseId,
    TREX1__Session__r: { Name: "Fall 2026" }
  },
  TREX1__Course_Option__c: `${Id}OPT`,
  TREX1__Course_Option__r: {
    Name,
    TREX1__Start_Date__c: "2026-11-02",
    TREX1__End_Date__c: "2026-12-14",
    TREX1__Day_of_Week__c: "Monday;Wednesday",
    TREX1__Start_Time_Formula__c: startTime,
    TREX1__End_Time_Formula__c: "19:00:00.000",
    TREX1__Age_Min__c: 6,
    TREX1__Age_Max__c: 12,
    TREX1__Instructor__c: "Sim Instructor",
    TREX1__Capacity__c: 10,
    TREX1__Registration_Total__c: 0,
    TREX1__Total_Capacity_Available__c: 10,
    TREX1__Unlimited_Capacity__c: false,
    TREX1__Show_Capacity_Online__c: true,
    TREX1__Waitlist_Total__c: 0,
    TREX1__Waitlist_Capacity__c: 0,
    TREX1__Description__c: null,
    TREX1__Product__c: ids.product
  }
});

/** The real published set plus the SIMTEST records, as fetchAll returns it. */
function withSimRecords(real) {
  const tr = structuredClone(real);
  const byName = (rows, name) => rows.find((r) => r.Name === name);
  const sports = byName(tr.program_categories.records, "Sports");
  const fitness = byName(tr.program_categories.records, "Fitness");
  const mcat = tr.membership_categories.records[0];
  assert.ok(sports && fitness && mcat, "the real data has Sports, Fitness and a membership category");

  tr.programs.records.push({
    Id: ids.program,
    Name: "SIMTEST Program",
    TREX1__Available__c: true,
    TREX1__Available_Online__c: true,
    TREX1__Description__c: "Simulated program for the sync scenario tests.",
    LastModifiedDate: STAMP,
    SystemModstamp: STAMP
  });
  tr.programs.extras.parentByChild.set(ids.program, [sports.Id]);
  tr.courses.records.push(course(ids.course1, "SIMTEST Course One"), course(ids.course2, "SIMTEST Course Two"));
  tr.classes.records.push(
    cls(ids.class1, "SIMTEST Class A", ids.course1, "18:00:00.000"),
    cls(ids.class2, "SIMTEST Class B", ids.course1, "18:30:00.000")
  );
  const product = (Id, Name) => ({ Id, Name, TREX1__Price_Description__c: "$50.00", LastModifiedDate: STAMP, SystemModstamp: STAMP });
  const level = (Id, productId, type, amount, fee = null) => ({
    Id,
    Name: `SIMTEST ${type || "level"}`,
    TREX1__Product__c: productId,
    TREX1__Total_Billing_Schedule_Amount__c: amount,
    TREX1__Initial_Fee_Amount__c: fee,
    TREX1__Price_Type__c: type,
    LastModifiedDate: STAMP,
    SystemModstamp: STAMP
  });
  tr.products.push(product(ids.product, "SIMTEST Class Product"), product(ids.mtProduct, "SIMTEST Membership Product"));
  tr.priceLevels.push(
    level(ids.member, ids.product, "Member", 50),
    level(ids.nonMember, ids.product, "Non-Member", 60),
    level(ids.mtLevel, ids.mtProduct, null, 120, 20)
  );
  tr.billingSchedules.push({
    Id: ids.mtSchedule,
    Name: "SIMTEST Monthly",
    TREX1__Price_Level__c: ids.mtLevel,
    TREX1__Term_Type__c: "Monthly",
    TREX1__Amount__c: 10,
    TREX1__Total_Billing_Amount__c: 120,
    TREX1__Number_Of_Terms__c: 12,
    LastModifiedDate: STAMP,
    SystemModstamp: STAMP
  });
  tr.membership_types.records.push({
    Id: ids.mtype,
    Name: "SIMTEST Membership - Autopay",
    TREX1__Category__c: mcat.Id,
    TREX1__Category__r: { TREX1__Available_Online__c: true, TREX1__Available_For_Purchase__c: true },
    TREX1__Available_Online__c: true,
    TREX1__Available_For_Purchase__c: true,
    TREX1__Description__c: "Simulated membership type.",
    TREX1__Min_Age__c: 18,
    TREX1__Max_Age__c: 61,
    TREX1__Term_Length__c: 1,
    TREX1__Term_Type__c: "Monthly",
    TREX1__Is_Group__c: false,
    TREX1__Product__c: ids.mtProduct,
    TREX1__Product__r: { TREX1__Price_Description__c: "$10.00" },
    LastModifiedDate: STAMP,
    SystemModstamp: STAMP
  });
  return { tr, sports, fitness };
}

/**
 * The source the sync reads. `published` is what fetchAll returns; `outside`
 * holds SIMTEST records that left the published set but still exist (fetchByIds
 * finds them). Real ids are re-read from the real Traction Rec.
 */
function simulatedSource(real) {
  const state = { published: null, outside: new Map() };
  return {
    state,
    fetchAll: async () => structuredClone(state.published),
    fetchByIds: async (tier, wanted) => {
      const found = await real.fetchByIds(tier, wanted.filter((id) => !id.startsWith(SIM)));
      for (const id of wanted.filter((id) => id.startsWith(SIM))) {
        if (state.outside.has(id)) {
          found.set(id, structuredClone(state.outside.get(id)));
        }
      }
      return found;
    }
  };
}

// --- reading the instance back ------------------------------------------------

async function readRows(zesty, models, datasetKey) {
  return (await indexItems(zesty, models.get(datasetKey))).byTrId;
}
async function readPage(zesty, models, model, trId) {
  return (await indexItems(zesty, models.get(model))).byTrId.get(trId) || null;
}
async function stageHtml(urlPath) {
  const res = await fetch(`${STAGE}${urlPath}?cb=${Date.now()}`);
  return { status: res.status, html: await res.text() };
}
const pathOf = (page) => page.web.path || `/${String(page.web.pathPart || "").replace(/^\/+|\/+$/g, "")}/`;

/** Delete every SIMTEST item: dataset rows and page items. */
async function cleanup(zesty, models) {
  let n = 0;
  for (const key of [...DATASETS.map((d) => d.key), ...PAGE_MODELS]) {
    const modelZuid = models.get(key);
    for (const item of (await indexItems(zesty, modelZuid)).all) {
      if (String((item.data && item.data.tractionrec_id) || "").startsWith(SIM)) {
        ok(await zesty.instance.deleteItem(modelZuid, item.meta.ZUID), `deleteItem ${item.meta.ZUID}`);
        n++;
      }
    }
  }
  return n;
}

// --- the scenarios ------------------------------------------------------------

async function main() {
  const cfg = load();
  const zesty = await connect(cfg.zesty);
  const models = await indexModels(zesty);
  const real = tractionRecSource(new TractionRecClient(cfg.tr));
  const results = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
      console.log(`✔ ${name} (${Math.round((Date.now() - t0) / 1000)} s)`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.log(`✘ ${name}\n    ${err.message.split("\n").join("\n    ")}`);
    }
  };

  console.log(`removed ${await cleanup(zesty, models)} SIMTEST items left by an earlier run`);
  const snapshot = await real.fetchAll();
  const { tr: base, fitness } = withSimRecords(snapshot);
  const source = simulatedSource(real);
  source.state.published = base;
  const pub = source.state.published;
  const sync = async () => {
    const report = await run({ dryRun: false, source, zestyClient: zesty });
    assert.equal(report.errorCount, 0, `sync errors: ${JSON.stringify(Object.values(report.datasets).flatMap((d) => d.errors))}`);
    return report;
  };
  const realRowsChanged = (report) =>
    Object.entries(report.datasets).flatMap(([k, d]) =>
      [...d.deactivated, ...d.reactivated].filter((x) => !x.trId.startsWith(SIM)).map((x) => `${k}:${x.trId}`)
    );
  const row = async (ds, id) => (await readRows(zesty, models, ds)).get(id);
  const findClass = (id) => pub.classes.records.find((r) => r.Id === id);
  let pageOf = {};

  await step("1. new records: rows created active, pages created at the root (slug told apart by parent), relations set", async () => {
    const report = await sync();
    assert.deepEqual(realRowsChanged(report), [], "no real record may change");
    for (const [ds, id] of [["tr_programs", ids.program], ["tr_courses", ids.course1], ["tr_classes", ids.class1], ["tr_products", ids.product], ["tr_price_levels", ids.member], ["tr_membership_types", ids.mtype], ["tr_billing_schedules", ids.mtSchedule]]) {
      const r = await row(ds, id);
      assert.ok(r, `${ds} ${id} exists`);
      assert.equal(String(r.data.active), "1", `${ds} ${id} active`);
    }
    for (const [model, id, title] of [["programs", ids.program, "SIMTEST Program"], ["courses", ids.course1, "SIMTEST Course One"], ["classes", ids.class1, "SIMTEST Class A"]]) {
      const page = await readPage(zesty, models, model, id);
      assert.ok(page, `${model} page for ${id}`);
      assert.equal(page.web.metaTitle, title);
      pageOf[id] = page;
    }
    const classRow = await row("tr_classes", ids.class1);
    assert.equal(classRow.data.page, pageOf[ids.class1].meta.ZUID, "class row points at its new page");
    const courseRow = await row("tr_courses", ids.course1);
    assert.equal(classRow.data.course, courseRow.meta.ZUID, "class -> course relation");
    const { html } = await stageHtml(pathOf(pageOf[ids.course1]));
    assert.match(html, /SIMTEST Class A/, "course page lists the class");
    assert.match(html, /SIMTEST Class B/, "course page lists the second class");
  });

  await step("2. a second run writes nothing", async () => {
    const report = await sync();
    for (const [k, d] of Object.entries(report.datasets)) {
      assert.equal(d.created + d.updated + d.pagesCreated.length + d.pagesRenamed.length, 0, `${k} wrote something`);
    }
  });

  await step("3. field change: spots and a price change -> rows updated, page shows them", async () => {
    findClass(ids.class1).TREX1__Course_Option__r.TREX1__Total_Capacity_Available__c = 3;
    pub.priceLevels.find((l) => l.Id === ids.member).TREX1__Total_Billing_Schedule_Amount__c = 55;
    const report = await sync();
    assert.equal(report.datasets.tr_classes.updated, 1);
    assert.equal(report.datasets.tr_price_levels.updated, 1);
    assert.equal(String((await row("tr_classes", ids.class1)).data.capacity_available), "3");
    const { html } = await stageHtml(pathOf(pageOf[ids.class1]));
    assert.match(html, /"capacity_available": "3"/);
    assert.match(html, /"amount": "55"/);
  });

  await step("4. rename: row + page title / SEO title follow, the URL slug does not", async () => {
    const before = await readPage(zesty, models, "courses", ids.course1);
    pub.courses.records.find((c) => c.Id === ids.course1).Name = "SIMTEST Course Uno";
    const report = await sync();
    assert.deepEqual(report.datasets.tr_courses.pagesRenamed.map((p) => p.trId), [ids.course1]);
    const after = await readPage(zesty, models, "courses", ids.course1);
    assert.equal((await row("tr_courses", ids.course1)).data.name, "SIMTEST Course Uno");
    assert.equal(after.data.course_name, "SIMTEST Course Uno");
    assert.equal(after.web.metaTitle, "SIMTEST Course Uno");
    assert.equal(after.web.metaLinkText, "SIMTEST Course Uno");
    assert.equal(after.web.pathPart, before.web.pathPart, "slug unchanged");
    const { status } = await stageHtml(pathOf(before));
    assert.equal(status, 200, "the old URL still answers");
  });

  await step("5. re-parent: program moves to Fitness, class B moves to course Two", async () => {
    pub.programs.extras.parentByChild.set(ids.program, [fitness.Id]);
    findClass(ids.class2).TREX1__cso_Course_Session__r.TREX1__Course__c = ids.course2;
    await sync();
    const fitnessRow = await row("tr_program_categories", fitness.Id);
    assert.equal((await row("tr_programs", ids.program)).data.program_categories, fitnessRow.meta.ZUID);
    assert.equal((await row("tr_classes", ids.class2)).data.course, (await row("tr_courses", ids.course2)).meta.ZUID);
    const cat = await stageHtml(pathOf(await readPage(zesty, models, "categories", fitness.Id)));
    assert.match(cat.html, /SIMTEST Program/, "Fitness lists the program");
    const two = await stageHtml(pathOf(await readPage(zesty, models, "courses", ids.course2)));
    assert.match(two.html, /SIMTEST Class B/, "course Two lists class B");
    const one = await stageHtml(pathOf(pageOf[ids.course1]));
    assert.doesNotMatch(one.html, /SIMTEST Class B/, "course One no longer lists class B");
  });

  await step("6. registration closes: class A leaves the set -> inactive with Traction Rec's reason, hidden from listings, page says closed", async () => {
    const a = findClass(ids.class1);
    source.state._closedA = a;
    pub.classes.records = pub.classes.records.filter((r) => r.Id !== ids.class1);
    source.state.outside.set(ids.class1, { ...a, TREX1__Course_Online_Availability__c: "Outside Course Option Registration Timeframe |" });
    const report = await sync();
    assert.deepEqual(report.datasets.tr_classes.deactivated.map((d) => d.trId), [ids.class1]);
    const r = await row("tr_classes", ids.class1);
    assert.equal(String(r.data.active), "0");
    assert.equal(r.data.inactive_reason, "Outside Course Option Registration Timeframe");
    const course1 = await stageHtml(pathOf(pageOf[ids.course1]));
    assert.doesNotMatch(course1.html, /SIMTEST Class A/, "course page no longer lists it");
    const own = await stageHtml(pathOf(pageOf[ids.class1]));
    assert.equal(own.status, 200, "its page still answers");
    assert.match(own.html, /"active": "0"/, "its page gets the inactive row (rendered as Registration closed)");
  });

  await step("7. comes back: class A is published again -> active again, listed again", async () => {
    source.state.outside.delete(ids.class1);
    assert.ok(source.state._closedA, "step 6 ran");
    pub.classes.records.push(source.state._closedA);
    const report = await sync();
    assert.deepEqual(report.datasets.tr_classes.reactivated.map((d) => d.trId), [ids.class1]);
    assert.equal(String((await row("tr_classes", ids.class1)).data.active), "1");
    assert.match((await stageHtml(pathOf(pageOf[ids.course1]))).html, /SIMTEST Class A/);
  });

  await step("8. deleted in Traction Rec: class B is gone entirely -> inactive 'Removed', data kept", async () => {
    pub.classes.records = pub.classes.records.filter((r) => r.Id !== ids.class2);
    await sync();
    const r = await row("tr_classes", ids.class2);
    assert.equal(String(r.data.active), "0");
    assert.equal(r.data.inactive_reason, "Removed from Traction Rec");
    assert.equal(r.data.name, "SIMTEST Class B", "last known data kept");
  });

  await step("9. lost parent: the program is untagged from every category -> inactive, keeps its old category", async () => {
    const before = (await row("tr_programs", ids.program)).data.program_categories;
    pub.programs.extras.parentByChild.delete(ids.program);
    await sync();
    const r = await row("tr_programs", ids.program);
    assert.equal(String(r.data.active), "0");
    assert.equal(r.data.inactive_reason, "No program_categories in Traction Rec");
    assert.equal(r.data.program_categories, before, "relation kept, not guessed");
    const cat = await stageHtml(pathOf(await readPage(zesty, models, "categories", fitness.Id)));
    assert.doesNotMatch(cat.html, /SIMTEST Program/, "Fitness no longer lists it");
  });

  await step("10. membership type no longer sold online -> inactive with the reason", async () => {
    const mt = pub.membership_types.records.find((r) => r.Id === ids.mtype);
    pub.membership_types.records = pub.membership_types.records.filter((r) => r.Id !== ids.mtype);
    source.state.outside.set(ids.mtype, { ...mt, TREX1__Available_Online__c: false });
    await sync();
    const r = await row("tr_membership_types", ids.mtype);
    assert.equal(String(r.data.active), "0");
    assert.equal(r.data.inactive_reason, "Type not available online");
  });

  await step("11. derived rows: the membership product is no longer used -> product, level, schedule inactive", async () => {
    pub.products = pub.products.filter((p) => p.Id !== ids.mtProduct);
    pub.priceLevels = pub.priceLevels.filter((l) => l.Id !== ids.mtLevel);
    pub.billingSchedules = pub.billingSchedules.filter((s) => s.Id !== ids.mtSchedule);
    await sync();
    for (const [ds, id] of [["tr_products", ids.mtProduct], ["tr_price_levels", ids.mtLevel], ["tr_billing_schedules", ids.mtSchedule]]) {
      const r = await row(ds, id);
      assert.equal(String(r.data.active), "0", `${ds} inactive`);
      assert.equal(r.data.inactive_reason, "No longer used by a published class or membership type");
    }
  });

  await step("12. steady state: one more run writes nothing", async () => {
    const report = await sync();
    for (const [k, d] of Object.entries(report.datasets)) {
      assert.equal(d.created + d.updated + d.pagesCreated.length + d.pagesRenamed.length, 0, `${k} wrote something`);
    }
  });

  await step("13. cleanup: SIMTEST items deleted, then a real run writes nothing", async () => {
    const n = await cleanup(zesty, models);
    assert.ok(n > 0, "deleted the SIMTEST items");
    const report = await run({ dryRun: false, source: real, zestyClient: zesty });
    assert.equal(report.errorCount, 0);
    for (const [k, d] of Object.entries(report.datasets)) {
      assert.equal(d.created + d.updated + d.pagesCreated.length, 0, `${k} wrote something on the real run`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} scenario steps passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
