/**
 * Which IRS blanks the catalog knows, by the IRS's own file slug
 * (irs.gov/pub/irs-prior/<slug>--<rev>.pdf).
 *
 * Annual forms are listed for 2021–2025. Forms the IRS revises irregularly are
 * listed for every revision year that may still be in use, because filers'
 * software keeps printing old revisions: the 2022–2025 Edgewater returns carry
 * 1125-A (Rev. 2018), 1125-E (Rev. 2016), Schedule G (Rev. 2011) and 7203
 * (Rev. 2022). A revision the IRS never published is simply skipped (the
 * builder negative-caches the 404).
 *
 * Add a form here when a catalog reports a page it could not classify.
 */
const ANNUAL = ['2021', '2022', '2023', '2024', '2025']
const REVISIONS = ['2010', '2011', '2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025']

export interface BlankSpec { slug: string; title: string; revs: string[] }

const annual = (slug: string, title: string): BlankSpec => ({ slug, title, revs: ANNUAL })
const revised = (slug: string, title: string): BlankSpec => ({ slug, title, revs: REVISIONS })

export const BLANKS: BlankSpec[] = [
  // ── Individual ──
  annual('f1040', 'Form 1040'),
  annual('f1040s1', 'Form 1040 Schedule 1'),
  annual('f1040s2', 'Form 1040 Schedule 2'),
  annual('f1040s3', 'Form 1040 Schedule 3'),
  annual('f1040sa', 'Form 1040 Schedule A'),
  annual('f1040sb', 'Form 1040 Schedule B'),
  annual('f1040sc', 'Form 1040 Schedule C'),
  annual('f1040sd', 'Form 1040 Schedule D'),
  annual('f1040se', 'Form 1040 Schedule E'),
  annual('f1040sse', 'Form 1040 Schedule SE'),
  annual('f1040s8', 'Form 1040 Schedule 8812'),
  annual('f1040v', 'Form 1040-V'),
  revised('f1040x', 'Form 1040-X'),
  annual('f1040es', 'Form 1040-ES'),
  annual('f8949', 'Form 8949'),
  annual('f2441', 'Form 2441'),
  annual('f8959', 'Form 8959'),
  annual('f8960', 'Form 8960'),
  annual('f8995', 'Form 8995'),
  annual('f8995a', 'Form 8995-A'),
  annual('f8582', 'Form 8582'),
  annual('f6781', 'Form 6781'),
  annual('f8606', 'Form 8606'),
  annual('f2210', 'Form 2210'),
  annual('f4952', 'Form 4952'),
  annual('f6251', 'Form 6251'),
  annual('f8283', 'Form 8283'),
  annual('f8889', 'Form 8889'),
  annual('f1116', 'Form 1116'),
  annual('f4797', 'Form 4797'),
  annual('f8829', 'Form 8829'),
  annual('f4868', 'Form 4868'),
  revised('f8915f', 'Form 8915-F'),
  revised('f7203', 'Form 7203'),
  // ── Corporate ──
  annual('f1120', 'Form 1120'),
  revised('f1120x', 'Form 1120-X'),
  annual('f1120w', 'Form 1120-W'),
  revised('f1120sg', 'Form 1120 Schedule G'),
  revised('f1120so', 'Form 1120 Schedule O'),
  revised('f1125a', 'Form 1125-A'),
  revised('f1125e', 'Form 1125-E'),
  annual('f2220', 'Form 2220'),
  annual('f4562', 'Form 4562'),
  annual('f4626', 'Form 4626'),
  annual('f3800', 'Form 3800'),
  revised('f7004', 'Form 7004'),
  revised('f8879corp', 'Form 8879-CORP'),
  revised('f8879c', 'Form 8879-C'),
  revised('f8879s', 'Form 8879-S'),
  annual('f8879', 'Form 8879'),
  annual('f1120sh', 'Form 1120 Schedule H'),
  annual('f8916a', 'Form 8916-A'),
  // ── S corporation ──
  annual('f1120s', 'Form 1120-S'),
  annual('f1120ssk', 'Form 1120-S Schedule K-1'),
  annual('f1120ssd', 'Form 1120-S Schedule D'),
  annual('f8825', 'Form 8825'),
  revised('f2553', 'Form 2553'),
  // ── Partnership ──
  annual('f1065', 'Form 1065'),
  annual('f1065sk1', 'Form 1065 Schedule K-1'),
  // ── Employment / information ──
  revised('f941', 'Form 941'),
  revised('f843', 'Form 843'),
  revised('f2848', 'Form 2848'),
  revised('f4506', 'Form 4506'),
]

const TITLES = new Map(BLANKS.map(b => [b.slug, b.title]))
export function titleFor(slug: string): string {
  return TITLES.get(slug) ?? slug
}
