# How Traction Rec data reaches the KROC website

*As of 5 October 2026*

## In short

The website's class catalog (categories, programs, courses and classes) now
comes straight from Traction Rec, the system staff already use to run
registration. A small background service copies the catalog to the website
automatically, so names, schedules, prices and open spots match Traction Rec
without anyone retyping them.

## How it works

1. **Staff work in Traction Rec, as they do today.** They set up programs,
   courses and classes, with their dates, prices and capacity.
2. **The sync service reads the catalog on a schedule.** It only picks up what
   Traction Rec offers online.
3. **It saves a copy on the website.** The first time it sees something new,
   it also creates that item's web page.
4. **The website shows the copy.** Visitors browse the catalog, and "Register"
   takes them to Traction Rec's own registration page to sign up and pay.

The service only writes what has changed since its last run. When nothing
changes in Traction Rec, nothing changes on the website.

## Who edits what

Each piece of information has one home. Change it there, and only there.

| Information | Edit it in |
| --- | --- |
| Names, descriptions, dates, days and times, ages, instructors | Traction Rec |
| Prices, capacity and open spots, the registration link | Traction Rec |
| Which category a program sits in, which program a course belongs to | Traction Rec |
| Photos, icons, page subtitles and intro text | Website (Zesty) |
| Class type, location, tags | Website (Zesty) |
| Page address, search-engine title and description | Website (Zesty) |

## What to know

- **Traction Rec data cannot be edited on the website.** Changing a class's
  price, date or description in Zesty has no effect: the site always shows
  Traction Rec's version. Zesty's editor still displays some of these fields
  today; they will be removed so nobody edits them by mistake.
- **Changes appear on the next sync, not instantly.** An update in Traction
  Rec shows on the website after the service's next run. Open-spot counts can
  therefore be slightly behind; Traction Rec's registration page always has
  the live number.
- **Nothing is deleted automatically.** When a class leaves Traction Rec, the
  website stops listing it, but its page is kept until someone decides to
  remove it. This protects photos and text an editor may have added.
- **New items get a page automatically.** A new program, course or class in
  Traction Rec gets its web page on the next sync. It starts with placeholder
  images until an editor adds real ones.
- **Some details have no source yet.** Traction Rec holds no class locations,
  so the website cannot show them until that is added.

## Where it stands

The sync works end to end against Traction Rec's test environment. It
currently carries 9 categories, 20 programs, 118 courses and 64 classes. The
redesigned catalog pages use it on the staging site; the live site does not
yet.

Next steps:

- Publish the catalog pages to the live site.
- Turn on the schedule. Proposed: classes every 30 minutes, the rest daily.
  Before that, confirm with the Traction Rec administrator how often the
  system may be read.
- Fix two page addresses: the catalog home page, and a test page that blocks
  the Basketball program page.
- Remove the duplicated Traction Rec fields from the website editor.
