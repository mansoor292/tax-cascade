/**
 * IRS Tax Tables — 2020 through 2025
 * 
 * Sources (all official IRS Revenue Procedures):
 *   TY2020: Rev. Proc. 2019-44
 *   TY2021: Rev. Proc. 2020-45
 *   TY2022: Rev. Proc. 2021-45
 *   TY2023: Rev. Proc. 2022-38
 *   TY2024: Rev. Proc. 2023-34
 *   TY2025: Rev. Proc. 2024-40
 *
 * Note: TCJA brackets (7 rates: 10/12/22/24/32/35/37%) apply TY2018–2025.
 *       Made permanent for 2026+ by One Big Beautiful Bill Act (Rev. Proc. 2025-32).
 */

export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh' | 'qw'

// Each bracket: [floor, rate, base_tax_at_floor]
// Tax = base_tax + (income - floor) * rate
type Bracket = [number, number, number]

interface YearlyTables {
  brackets:          Record<FilingStatus, Bracket[]>
  standard_deduction: Record<FilingStatus, number>
  qbi_threshold:     Record<FilingStatus, number>   // §199A phase-in starts here
  qbi_phaseout:      Record<FilingStatus, number>   // §199A fully phased out here
  amt_exemption:     Record<'single'|'mfj'|'mfs', number>
  amt_phaseout:      Record<'single'|'mfj'|'mfs', number>
  ltcg_0pct_limit:   Record<FilingStatus, number>   // 0% LTCG rate up to this
  ltcg_15pct_limit:  Record<FilingStatus, number>   // 15% LTCG up to this
  niit_threshold:    Record<'single'|'mfj'|'mfs', number> // 3.8% NIIT
  child_tax_credit:  number
  ctc_refundable_max: number
  educator_expense:  number
  student_loan_interest_max: number
}

// ─────────────────────────────────────────────────────────────
// TY2018  (Rev. Proc. 2018-18) — first TCJA year
// ─────────────────────────────────────────────────────────────
const TY2018: YearlyTables = {
  brackets: {
    single: [[0,0.10,0],[9525,0.12,952.50],[38700,0.22,4453.50],[82500,0.24,14089.50],[157500,0.32,32089.50],[200000,0.35,45689.50],[500000,0.37,150689.50]],
    mfj: [[0,0.10,0],[19050,0.12,1905],[77400,0.22,8907],[165000,0.24,28179],[315000,0.32,64179],[400000,0.35,91379],[600000,0.37,161379]],
    mfs: [[0,0.10,0],[9525,0.12,952.50],[38700,0.22,4453.50],[82500,0.24,14089.50],[157500,0.32,32089.50],[200000,0.35,45689.50],[300000,0.37,80689.50]],
    hoh: [[0,0.10,0],[13600,0.12,1360],[51800,0.22,5944],[82500,0.24,12698],[157500,0.32,30698],[200000,0.35,44298],[500000,0.37,149298]],
    qw: [[0,0.10,0],[19050,0.12,1905],[77400,0.22,8907],[165000,0.24,28179],[315000,0.32,64179],[400000,0.35,91379],[600000,0.37,161379]],
  },
  standard_deduction: { single:12000, mfj:24000, mfs:12000, hoh:18000, qw:24000 },
  qbi_threshold:      { single:157500, mfj:315000, mfs:157500, hoh:157500, qw:315000 },
  qbi_phaseout:       { single:207500, mfj:415000, mfs:207500, hoh:207500, qw:415000 },
  amt_exemption:      { single:70300, mfj:109400, mfs:54700 },
  amt_phaseout:       { single:500000, mfj:1000000, mfs:500000 },
  ltcg_0pct_limit:    { single:38600, mfj:77200, mfs:38600, hoh:51700, qw:77200 },
  ltcg_15pct_limit:   { single:425800, mfj:479000, mfs:239500, hoh:452400, qw:479000 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1400,
  educator_expense:   250,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2019  (Rev. Proc. 2018-57)
// ─────────────────────────────────────────────────────────────
const TY2019: YearlyTables = {
  brackets: {
    single: [[0,0.10,0],[9700,0.12,970],[39475,0.22,4543],[84200,0.24,14382.50],[160725,0.32,32748.50],[204100,0.35,46628.50],[510300,0.37,153798.50]],
    mfj: [[0,0.10,0],[19400,0.12,1940],[78950,0.22,9086],[168400,0.24,28765],[321450,0.32,65497],[408200,0.35,93257],[612350,0.37,164709.50]],
    mfs: [[0,0.10,0],[9700,0.12,970],[39475,0.22,4543],[84200,0.24,14382.50],[160725,0.32,32748.50],[204100,0.35,46628.50],[306175,0.37,82354.75]],
    hoh: [[0,0.10,0],[13850,0.12,1385],[52850,0.22,6065],[84200,0.24,12962],[160700,0.32,31322],[204100,0.35,45210],[510300,0.37,152380]],
    qw: [[0,0.10,0],[19400,0.12,1940],[78950,0.22,9086],[168400,0.24,28765],[321450,0.32,65497],[408200,0.35,93257],[612350,0.37,164709.50]],
  },
  standard_deduction: { single:12200, mfj:24400, mfs:12200, hoh:18350, qw:24400 },
  qbi_threshold:      { single:160700, mfj:321400, mfs:160700, hoh:160700, qw:321400 },
  qbi_phaseout:       { single:210700, mfj:421400, mfs:210700, hoh:210700, qw:421400 },
  amt_exemption:      { single:71700, mfj:111700, mfs:55850 },
  amt_phaseout:       { single:510300, mfj:1020600, mfs:510300 },
  ltcg_0pct_limit:    { single:39375, mfj:78750, mfs:39375, hoh:52750, qw:78750 },
  ltcg_15pct_limit:   { single:434550, mfj:488850, mfs:244425, hoh:461700, qw:488850 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1400,
  educator_expense:   250,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2020  (Rev. Proc. 2019-44)
// ─────────────────────────────────────────────────────────────
const TY2020: YearlyTables = {
  brackets: {
    single: [
      [0,       0.10, 0],
      [9875,    0.12, 987.50],
      [40125,   0.22, 4617.50],
      [85525,   0.24, 14605.50],
      [163300,  0.32, 33271.50],
      [207350,  0.35, 47367.50],
      [518400,  0.37, 156235],
    ],
    mfj: [
      [0,       0.10, 0],
      [19750,   0.12, 1975],
      [80250,   0.22, 9235],
      [171050,  0.24, 29211],
      [326600,  0.32, 66543],
      [414700,  0.35, 94735],
      [622050,  0.37, 167307.50],
    ],
    mfs: [
      [0,       0.10, 0],
      [9875,    0.12, 987.50],
      [40125,   0.22, 4617.50],
      [85525,   0.24, 14605.50],
      [163300,  0.32, 33271.50],
      [207350,  0.35, 47367.50],
      [311025,  0.37, 83653.75],
    ],
    hoh: [
      [0,       0.10, 0],
      [14100,   0.12, 1410],
      [53700,   0.22, 6162],
      [85500,   0.24, 13158],
      [163300,  0.32, 31830],
      [207350,  0.35, 45926],
      [518400,  0.37, 154793.50],
    ],
    qw: [  // Same as MFJ
      [0, 0.10, 0],[19750,0.12,1975],[80250,0.22,9235],
      [171050,0.24,29211],[326600,0.32,66543],[414700,0.35,94735],[622050,0.37,167307.50],
    ],
  },
  standard_deduction: { single:12400, mfj:24800, mfs:12400, hoh:18650, qw:24800 },
  qbi_threshold:      { single:163300, mfj:326600, mfs:163300, hoh:163300, qw:326600 },
  qbi_phaseout:       { single:213300, mfj:426600, mfs:213300, hoh:213300, qw:426600 },
  amt_exemption:      { single:72900, mfj:113400, mfs:56700 },
  amt_phaseout:       { single:518400, mfj:1036800, mfs:518400 },
  ltcg_0pct_limit:    { single:40000, mfj:80000, mfs:40000, hoh:53600, qw:80000 },
  ltcg_15pct_limit:   { single:441450, mfj:496600, mfs:248300, hoh:469050, qw:496600 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1400,
  educator_expense:   250,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2021  (Rev. Proc. 2020-45)
// ─────────────────────────────────────────────────────────────
const TY2021: YearlyTables = {
  brackets: {
    single: [
      [0,      0.10, 0],
      [9950,   0.12, 995],
      [40525,  0.22, 4664],
      [86375,  0.24, 14751],
      [164925, 0.32, 33603],
      [209425, 0.35, 47843],
      [523600, 0.37, 157804.25],
    ],
    mfj: [
      [0,       0.10, 0],
      [19900,   0.12, 1990],
      [81050,   0.22, 9328],
      [172750,  0.24, 29502],
      [329850,  0.32, 67206],
      [418850,  0.35, 95686],
      [628300,  0.37, 168993.50],
    ],
    mfs: [
      [0,      0.10, 0],
      [9950,   0.12, 995],
      [40525,  0.22, 4664],
      [86375,  0.24, 14751],
      [164925, 0.32, 33603],
      [209425, 0.35, 47843],
      [314150, 0.37, 84496.75],
    ],
    hoh: [
      [0,       0.10, 0],
      [14200,   0.12, 1420],
      [54200,   0.22, 6220],
      [86350,   0.24, 13293],
      [164900,  0.32, 32145],
      [209400,  0.35, 46385],
      [523600,  0.37, 156355],
    ],
    qw: [
      [0,0.10,0],[19900,0.12,1990],[81050,0.22,9328],
      [172750,0.24,29502],[329850,0.32,67206],[418850,0.35,95686],[628300,0.37,168993.50],
    ],
  },
  standard_deduction: { single:12550, mfj:25100, mfs:12550, hoh:18800, qw:25100 },
  qbi_threshold:      { single:164900, mfj:329800, mfs:164900, hoh:164900, qw:329800 },
  qbi_phaseout:       { single:214900, mfj:429800, mfs:214900, hoh:214900, qw:429800 },
  amt_exemption:      { single:73600, mfj:114600, mfs:57300 },
  amt_phaseout:       { single:523600, mfj:1047200, mfs:523600 },
  ltcg_0pct_limit:    { single:40400, mfj:80800, mfs:40400, hoh:54100, qw:80800 },
  ltcg_15pct_limit:   { single:445850, mfj:501600, mfs:250800, hoh:473750, qw:501600 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   3000,   // ARPA expansion (per qualifying child under 6: $3600)
  ctc_refundable_max: 3000,
  educator_expense:   250,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2022  (Rev. Proc. 2021-45)
// ─────────────────────────────────────────────────────────────
const TY2022: YearlyTables = {
  brackets: {
    single: [
      [0,      0.10, 0],
      [10275,  0.12, 1027.50],
      [41775,  0.22, 4807.50],
      [89075,  0.24, 15213.50],
      [170050, 0.32, 34647.50],
      [215950, 0.35, 49335.50],
      [539900, 0.37, 162718],
    ],
    mfj: [
      [0,       0.10, 0],
      [20550,   0.12, 2055],
      [83550,   0.22, 9615],
      [178150,  0.24, 30427],
      [340100,  0.32, 69295],
      [431900,  0.35, 98671],
      [647850,  0.37, 174253.50],
    ],
    mfs: [
      [0,      0.10, 0],
      [10275,  0.12, 1027.50],
      [41775,  0.22, 4807.50],
      [89075,  0.24, 15213.50],
      [170050, 0.32, 34647.50],
      [215950, 0.35, 49335.50],
      [323925, 0.37, 87126.75],
    ],
    hoh: [
      [0,       0.10, 0],
      [14650,   0.12, 1465],
      [55900,   0.22, 6415],
      [89050,   0.24, 13708],
      [170050,  0.32, 33148],
      [215950,  0.35, 47836],
      [539900,  0.37, 161218.50],
    ],
    qw: [
      [0,0.10,0],[20550,0.12,2055],[83550,0.22,9615],
      [178150,0.24,30427],[340100,0.32,69295],[431900,0.35,98671],[647850,0.37,174253.50],
    ],
  },
  standard_deduction: { single:12950, mfj:25900, mfs:12950, hoh:19400, qw:25900 },
  qbi_threshold:      { single:170050, mfj:340100, mfs:170050, hoh:170050, qw:340100 },
  qbi_phaseout:       { single:220050, mfj:440100, mfs:220050, hoh:220050, qw:440100 },
  amt_exemption:      { single:75900, mfj:118100, mfs:59050 },
  amt_phaseout:       { single:539900, mfj:1079800, mfs:539900 },
  ltcg_0pct_limit:    { single:41675, mfj:83350, mfs:41675, hoh:55800, qw:83350 },
  ltcg_15pct_limit:   { single:459750, mfj:517200, mfs:258600, hoh:488500, qw:517200 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1500,
  educator_expense:   300,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2023  (Rev. Proc. 2022-38)
// ─────────────────────────────────────────────────────────────
const TY2023: YearlyTables = {
  brackets: {
    single: [
      [0,      0.10, 0],
      [11000,  0.12, 1100],
      [44725,  0.22, 5147],
      [95375,  0.24, 16290],
      [182050, 0.32, 37104],
      [231250, 0.35, 52832],
      [578125, 0.37, 174238.25],
    ],
    mfj: [
      [0,       0.10, 0],
      [22000,   0.12, 2200],
      [89450,   0.22, 10294],
      [190750,  0.24, 32580],
      [364200,  0.32, 74208],
      [462500,  0.35, 105664],
      [693750,  0.37, 186601.50],
    ],
    mfs: [
      [0,      0.10, 0],
      [11000,  0.12, 1100],
      [44725,  0.22, 5147],
      [95375,  0.24, 16290],
      [182050, 0.32, 37104],
      [231250, 0.35, 52832],
      [346875, 0.37, 93300.75],
    ],
    hoh: [
      [0,       0.10, 0],
      [15700,   0.12, 1570],
      [59850,   0.22, 6868],
      [95350,   0.24, 14678],
      [182050,  0.32, 35498],
      [231250,  0.35, 51226],
      [578100,  0.37, 172623.50],
    ],
    qw: [
      [0,0.10,0],[22000,0.12,2200],[89450,0.22,10294],
      [190750,0.24,32580],[364200,0.32,74208],[462500,0.35,105664],[693750,0.37,186601.50],
    ],
  },
  standard_deduction: { single:13850, mfj:27700, mfs:13850, hoh:20800, qw:27700 },
  qbi_threshold:      { single:182050, mfj:364200, mfs:182050, hoh:182050, qw:364200 },
  qbi_phaseout:       { single:232050, mfj:464200, mfs:232050, hoh:232050, qw:464200 },
  amt_exemption:      { single:81300, mfj:126500, mfs:63250 },
  amt_phaseout:       { single:578150, mfj:1156300, mfs:578150 },
  ltcg_0pct_limit:    { single:44625, mfj:89250, mfs:44625, hoh:59750, qw:89250 },
  ltcg_15pct_limit:   { single:492300, mfj:553850, mfs:276900, hoh:523050, qw:553850 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1600,
  educator_expense:   300,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2024  (Rev. Proc. 2023-34)
// ─────────────────────────────────────────────────────────────
const TY2024: YearlyTables = {
  brackets: {
    single: [
      [0,       0.10, 0],
      [11600,   0.12, 1160],
      [47150,   0.22, 5426],
      [100525,  0.24, 17168.50],
      [191950,  0.32, 39110.50],
      [243725,  0.35, 55678.50],
      [609350,  0.37, 183647.25],
    ],
    mfj: [
      [0,       0.10, 0],
      [23200,   0.12, 2320],
      [94300,   0.22, 10852],
      [201050,  0.24, 34337],
      [383900,  0.32, 78221],
      [487450,  0.35, 111357],
      [731200,  0.37, 196669.50],
    ],
    mfs: [
      [0,       0.10, 0],
      [11600,   0.12, 1160],
      [47150,   0.22, 5426],
      [100525,  0.24, 17168.50],
      [191950,  0.32, 39110.50],
      [243725,  0.35, 55678.50],
      [365600,  0.37, 98334.75],
    ],
    hoh: [
      [0,       0.10, 0],
      [16550,   0.12, 1655],
      [63100,   0.22, 7241],
      [100500,  0.24, 15469],
      [191950,  0.32, 37417],
      [243700,  0.35, 53977],
      [609350,  0.37, 181954.50],
    ],
    qw: [
      [0,0.10,0],[23200,0.12,2320],[94300,0.22,10852],
      [201050,0.24,34337],[383900,0.32,78221],[487450,0.35,111357],[731200,0.37,196669.50],
    ],
  },
  standard_deduction: { single:14600, mfj:29200, mfs:14600, hoh:21900, qw:29200 },
  qbi_threshold:      { single:191950, mfj:383900, mfs:191950, hoh:191950, qw:383900 },
  qbi_phaseout:       { single:241950, mfj:483900, mfs:241950, hoh:241950, qw:483900 },
  amt_exemption:      { single:85700, mfj:133300, mfs:66650 },
  amt_phaseout:       { single:609350, mfj:1218700, mfs:609350 },
  ltcg_0pct_limit:    { single:47025, mfj:94050, mfs:47025, hoh:63000, qw:94050 },
  ltcg_15pct_limit:   { single:518900, mfj:583750, mfs:291850, hoh:551350, qw:583750 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1700,
  educator_expense:   300,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// TY2025  (Rev. Proc. 2024-40)
// ─────────────────────────────────────────────────────────────
const TY2025: YearlyTables = {
  brackets: {
    single: [
      [0,       0.10, 0],
      [11925,   0.12, 1192.50],
      [48475,   0.22, 5578.50],
      [103350,  0.24, 17651],
      [197300,  0.32, 40199],
      [250525,  0.35, 57231],
      [626350,  0.37, 188769.75],
    ],
    mfj: [
      [0,       0.10, 0],
      [23850,   0.12, 2385],
      [96950,   0.22, 11157],
      [206700,  0.24, 35302],
      [394600,  0.32, 80398],
      [501050,  0.35, 114462],
      [751600,  0.37, 202154.50],
    ],
    mfs: [
      [0,       0.10, 0],
      [11925,   0.12, 1192.50],
      [48475,   0.22, 5578.50],
      [103350,  0.24, 17651],
      [197300,  0.32, 40199],
      [250525,  0.35, 57231],
      [375800,  0.37, 101077.25],
    ],
    hoh: [
      [0,       0.10, 0],
      [17000,   0.12, 1700],
      [64850,   0.22, 7442],
      [103350,  0.24, 15912],
      [197300,  0.32, 38460],
      [250500,  0.35, 55484],
      [626350,  0.37, 187031.50],
    ],
    qw: [
      [0,0.10,0],[23850,0.12,2385],[96950,0.22,11157],
      [206700,0.24,35302],[394600,0.32,80398],[501050,0.35,114462],[751600,0.37,202154.50],
    ],
  },
  standard_deduction: { single:15000, mfj:30000, mfs:15000, hoh:22500, qw:30000 },
  qbi_threshold:      { single:197300, mfj:394600, mfs:197300, hoh:197300, qw:394600 },
  qbi_phaseout:       { single:247300, mfj:494600, mfs:247300, hoh:247300, qw:494600 },
  amt_exemption:      { single:88100, mfj:137000, mfs:68500 },
  amt_phaseout:       { single:626350, mfj:1252700, mfs:626350 },
  ltcg_0pct_limit:    { single:48350, mfj:96700, mfs:48350, hoh:64750, qw:96700 },
  ltcg_15pct_limit:   { single:533400, mfj:600050, mfs:300000, hoh:566700, qw:600050 },
  niit_threshold:     { single:200000, mfj:250000, mfs:125000 },
  child_tax_credit:   2000,
  ctc_refundable_max: 1700,
  educator_expense:   300,
  student_loan_interest_max: 2500,
}

// ─────────────────────────────────────────────────────────────
// MASTER LOOKUP
// ─────────────────────────────────────────────────────────────
export const TAX_TABLES: Record<number, YearlyTables> = {
  2018: TY2018,
  2019: TY2019,
  2020: TY2020,
  2021: TY2021,
  2022: TY2022,
  2023: TY2023,
  2024: TY2024,
  2025: TY2025,
}

// ─────────────────────────────────────────────────────────────
// §199A(d)(2) SSTB classification by NAICS code
// ─────────────────────────────────────────────────────────────
//
// A Specified Service Trade or Business (SSTB) loses the QBI deduction
// above the phaseout threshold. IRC §199A(d)(2) lists the categories by
// activity; we translate to NAICS prefix-matching. This list is not
// exhaustive — the categories are principles-based, and Treas. Reg.
// §1.199A-5(b)(2) expands on "any trade or business where the principal
// asset is the reputation or skill of one or more of its employees."
// When in doubt, require human confirmation rather than auto-apply.
//
// Sources: IRS Pub 535 (prior years), §199A(d)(2), Reg §1.199A-5.

/** Prefix → §199A(d) category (human-readable, used in warnings). */
export const SSTB_NAICS_PREFIXES: Array<{ prefix: string; category: string }> = [
  // Health
  { prefix: '621',    category: 'Health (§199A(d)(2)(A))' },
  { prefix: '6211',   category: 'Offices of physicians' },
  { prefix: '6212',   category: 'Offices of dentists' },
  { prefix: '6213',   category: 'Offices of other health practitioners' },
  // Law
  { prefix: '5411',   category: 'Legal services (§199A(d)(2)(A))' },
  // Accounting
  { prefix: '54121',  category: 'Accounting, tax prep, bookkeeping, payroll (§199A(d)(2)(A))' },
  // Actuarial
  { prefix: '54133',  category: 'Engineering services — actuarial (§199A(d)(2)(A))' },
  // Performing arts
  { prefix: '7111',   category: 'Performing arts companies (§199A(d)(2)(A))' },
  { prefix: '7112',   category: 'Spectator sports (§199A(d)(2)(A))' },
  { prefix: '7115',   category: 'Independent artists, writers, performers' },
  // Consulting
  { prefix: '5416',   category: 'Management / scientific / technical consulting (§199A(d)(2)(A))' },
  // Athletics (overlap with 7112 + performing arts)
  // Financial services
  { prefix: '52393',  category: 'Investment advice (§199A(d)(2)(A))' },
  { prefix: '5231',   category: 'Securities and commodity contracts intermediation / brokerage' },
  // Brokerage services
  { prefix: '52599',  category: 'Other financial vehicles / brokerage (§199A(d)(2)(A))' },
  // Consulting services (subset of 5416 above, explicit)
  { prefix: '541611', category: 'Administrative management consulting' },
  { prefix: '541612', category: 'Human resources consulting' },
  { prefix: '541613', category: 'Marketing consulting' },
  { prefix: '541614', category: 'Process / physical distribution consulting' },
  { prefix: '541618', category: 'Other management consulting services' },
  { prefix: '541620', category: 'Environmental consulting' },
  { prefix: '541690', category: 'Other scientific / technical consulting' },
]

/**
 * Returns the matching SSTB category (if any) for a given NAICS / business
 * activity code. Match is longest-prefix-wins so `541213` (Tax prep)
 * matches `54121` (Accounting) rather than `5412` (if it existed).
 *
 * Used as a **flag**, not as an auto-apply: callers must still confirm
 * `is_sstb` explicitly before the QBI calc runs past the phaseout, since
 * §199A(d)(2)(B) "reputation or skill" trades aren't cleanly NAICS-coded.
 */
export function isSstbByNaics(code: string | undefined | null): { match: boolean; category?: string; prefix?: string } {
  if (!code) return { match: false }
  const clean = String(code).replace(/[^0-9]/g, '')
  if (!clean) return { match: false }
  let best: { prefix: string; category: string } | null = null
  for (const entry of SSTB_NAICS_PREFIXES) {
    if (clean.startsWith(entry.prefix)) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry
    }
  }
  return best ? { match: true, category: best.category, prefix: best.prefix } : { match: false }
}

// ─────────────────────────────────────────────────────────────
// CALCULATION FUNCTIONS
// ─────────────────────────────────────────────────────────────

/** Ordinary income tax from brackets */
export function ordinaryTax(
  taxable: number,
  status: FilingStatus,
  year: number
): number {
  if (taxable <= 0) return 0
  const t = TAX_TABLES[year]
  if (!t) throw new Error(`No tax table for year ${year}`)
  const brackets = t.brackets[status]
  for (let i = brackets.length - 1; i >= 0; i--) {
    if (taxable > brackets[i][0]) {
      return Math.round(brackets[i][2] + (taxable - brackets[i][0]) * brackets[i][1])
    }
  }
  return 0
}

/** Long-term capital gains / qualified dividends tax rate */
export function ltcgTax(
  ltcg_income: number,
  ordinary_taxable: number,
  status: FilingStatus,
  year: number
): number {
  if (ltcg_income <= 0) return 0
  const t = TAX_TABLES[year]
  const total = ordinary_taxable + ltcg_income
  const zero_limit = t.ltcg_0pct_limit[status]
  const fifteen_limit = t.ltcg_15pct_limit[status]

  // Amount of LTCG in 0% bracket
  const in_zero = Math.max(0, Math.min(ltcg_income, zero_limit - ordinary_taxable))
  // Remainder in 15% or 20%
  const remaining = ltcg_income - in_zero
  const in_fifteen = Math.max(0, Math.min(remaining, fifteen_limit - Math.max(ordinary_taxable, zero_limit)))
  const in_twenty = Math.max(0, remaining - in_fifteen)

  return Math.round(in_fifteen * 0.15 + in_twenty * 0.20)
}

/** Net Investment Income Tax (§1411) */
export function niitTax(
  net_investment_income: number,
  magi: number,
  status: 'single' | 'mfj' | 'mfs',
  year: number
): number {
  const t = TAX_TABLES[year]
  const threshold = t.niit_threshold[status]
  if (magi <= threshold) return 0
  const subject = Math.min(net_investment_income, magi - threshold)
  return Math.round(subject * 0.038)
}

/** Alternative Minimum Tax (simplified — Form 6251) */
export function amtTax(
  amti: number,   // Alternative Minimum Taxable Income (AMTI)
  status: 'single' | 'mfj' | 'mfs',
  year: number
): number {
  const t = TAX_TABLES[year]
  const exemption_full = t.amt_exemption[status]
  const phaseout_start = t.amt_phaseout[status]
  // Exemption phases out at 25 cents per dollar above threshold
  const phaseout_reduction = Math.max(0, Math.round((amti - phaseout_start) * 0.25))
  const exemption = Math.max(0, exemption_full - phaseout_reduction)
  const amt_taxable = Math.max(0, amti - exemption)
  // 26% on first $232,600 ($116,300 MFS), 28% above — TY2024 values
  const break_point = status === 'mfs' ? 116300 : 232600
  if (amt_taxable <= break_point) return Math.round(amt_taxable * 0.26)
  return Math.round(break_point * 0.26 + (amt_taxable - break_point) * 0.28)
}

/**
 * §199A QBI deduction
 *
 * Handles three regimes:
 *  1. Below threshold: 20% of QBI, capped at 20% of taxable income
 *  2. Above phaseout: SSTB → $0, non-SSTB → wage/UBIA limited
 *  3. Phase-in: linear ramp; SSTBs ramp QBI itself to zero, non-SSTBs ramp the limitation
 */
export function qbiDeduction(
  qbi_income:     number,
  w2_wages:       number,
  ubia:           number,        // Unadjusted basis of qualified property
  taxable_income: number,        // Before the QBI deduction
  status:         FilingStatus,
  year:           number,
  is_sstb:        boolean = false,
): number {
  if (qbi_income <= 0) return 0
  const t = TAX_TABLES[year]
  const threshold = t.qbi_threshold[status]
  const phaseout  = t.qbi_phaseout[status]
  const cap       = Math.round(taxable_income * 0.20)

  // Regime 1: below threshold — SSTBs get full 20% just like non-SSTBs
  if (taxable_income <= threshold) {
    return Math.min(Math.round(qbi_income * 0.20), cap)
  }

  // Regime 2: above phaseout
  if (taxable_income >= phaseout) {
    if (is_sstb) return 0  // SSTBs get zero above phaseout
    const tentative   = Math.round(qbi_income * 0.20)
    const wage_limit  = Math.round(w2_wages * 0.50)
    const wage_ubia   = Math.round(w2_wages * 0.25 + ubia * 0.025)
    const limitation  = Math.max(wage_limit, wage_ubia)
    return Math.min(tentative, limitation, cap)
  }

  // Regime 3: phase-in between threshold and phaseout
  const phase_ratio = (taxable_income - threshold) / (phaseout - threshold)

  if (is_sstb) {
    // SSTB: ramp QBI/wages/UBIA down to zero as ratio approaches 1
    const applicable_pct = 1 - phase_ratio
    const adj_qbi   = qbi_income * applicable_pct
    const adj_wages = w2_wages * applicable_pct
    const adj_ubia  = ubia * applicable_pct
    const tentative   = Math.round(adj_qbi * 0.20)
    const wage_limit  = Math.round(adj_wages * 0.50)
    const wage_ubia   = Math.round(adj_wages * 0.25 + adj_ubia * 0.025)
    const limitation  = Math.max(wage_limit, wage_ubia)
    const excess = Math.max(0, tentative - limitation)
    return Math.min(Math.round(tentative - phase_ratio * excess), cap)
  }

  // Non-SSTB phase-in: only the wage/UBIA limitation phases in
  const tentative   = Math.round(qbi_income * 0.20)
  const wage_limit  = Math.round(w2_wages * 0.50)
  const wage_ubia   = Math.round(w2_wages * 0.25 + ubia * 0.025)
  const limitation  = Math.max(wage_limit, wage_ubia)
  const phased = Math.round(tentative - phase_ratio * Math.max(0, tentative - limitation))
  return Math.min(tentative, phased, cap)
}

/** Standard deduction for the year/status */
export function standardDeduction(status: FilingStatus, year: number): number {
  return TAX_TABLES[year].standard_deduction[status]
}

/** Child Tax Credit */
export function childTaxCredit(
  num_children:   number,
  magi:           number,
  status:         FilingStatus,
  year:           number
): { credit: number; refundable: number } {
  const t = TAX_TABLES[year]
  const max_per_child = t.child_tax_credit
  let credit = num_children * max_per_child
  // Phase-out: $50 per $1,000 above threshold
  const threshold = status === 'mfj' ? 400000 : 200000
  const reduction = Math.max(0, Math.floor((magi - threshold) / 1000)) * 50
  credit = Math.max(0, credit - reduction)
  const refundable = Math.min(credit, num_children * t.ctc_refundable_max)
  return { credit, refundable }
}

/** Social Security wage base per year (SSA-published annual COLA) */
export const SS_WAGE_BASE: Record<number, number> = {
  2018: 128400, 2019: 132900, 2020: 137700, 2021: 142800,
  2022: 147000, 2023: 160200, 2024: 168600, 2025: 176100,
}

/** Self-employment tax (Schedule SE) */
export function seTax(
  net_se_income: number,
  year: number = 2025,
): { se_tax: number; deduction: number } {
  if (net_se_income <= 0) return { se_tax: 0, deduction: 0 }
  // 92.35% of net SE income is subject to SE tax
  const subject = Math.round(net_se_income * 0.9235)
  const ss_base_cap = SS_WAGE_BASE[year] ?? 176100
  const ss_base = Math.min(subject, ss_base_cap)
  const se_tax = Math.round(ss_base * 0.124 + subject * 0.029)  // 12.4% SS + 2.9% Medicare
  const deduction = Math.round(se_tax * 0.50)  // §164(f) deduction
  return { se_tax, deduction }
}

/** Additional Medicare Tax (0.9%) — Form 8959 */
export function additionalMedicareTax(
  wages: number,
  se_income: number,
  status: FilingStatus,
): number {
  const thresholds: Record<FilingStatus, number> = {
    single: 200000, mfj: 250000, mfs: 125000, hoh: 200000, qw: 200000,
  }
  const threshold = thresholds[status]
  // Wages above threshold are subject directly
  const wage_excess = Math.max(0, wages - threshold)
  // SE income uses reduced threshold (threshold minus wages)
  const se_subject = Math.round(se_income * 0.9235)  // same 92.35% basis
  const remaining_threshold = Math.max(0, threshold - wages)
  const se_excess = Math.max(0, se_subject - remaining_threshold)
  return Math.round((wage_excess + se_excess) * 0.009)
}

// ─────────────────────────────────────────────────────────────
// COMPLETE 1040 CALCULATOR
// ─────────────────────────────────────────────────────────────

export interface Form1040_Full {
  // Identity
  filing_status:   FilingStatus
  tax_year:        number
  num_dependents:  number
  // W-2 / Schedule 1 income
  wages:                  number
  taxable_interest:       number
  ordinary_dividends:     number
  qualified_dividends:    number
  taxable_ira:            number
  taxable_pensions:       number
  social_security_gross:  number
  net_capital_gain:       number
  ltcg_portion:           number   // portion of cap gain that is long-term
  schedule1_other_income: number   // alimony, gambling, etc.
  // K-1 pass-through (from 1120-S)
  k1_ordinary_income:     number
  k1_w2_wages:            number
  k1_ubia:                number
  k1_net_rental:          number
  // Self-employment
  net_se_income:          number
  // Above-the-line deductions (Schedule 1 Part II)
  se_tax_deduction?:      number   // computed if omitted
  educator_expenses:      number
  student_loan_interest:  number
  ira_deduction:          number
  // Below-the-line
  use_itemized:           boolean
  itemized_deductions:    number   // if use_itemized
  // Payments
  federal_withholding:    number
  estimated_payments:     number
  child_tax_credit_manual?: number  // override if known
}

export interface Form1040_Result {
  lines: {
    L1z_wages:            number
    L2b_taxable_interest: number
    L3b_ord_dividends:    number
    L4b_ira_taxable:      number
    L5b_pension_taxable:  number
    L6b_ss_taxable:       number
    L7_cap_gain:          number
    L8_other_income:      number
    L9_total_income:      number
    L10_adjustments:      number
    L11_agi:              number
    L12_deduction:        number
    L13_qbi_deduction:    number
    L14_total_deductions: number
    L15_taxable_income:   number
    L16_tax:              number
    L17_amt:              number
    L22_total_tax:        number
    L24_se_tax:           number
    L25_total_sched2:     number
    L25a_withholding:     number
    L26_estimated:        number
    L27_ctc:              number
    L33_total_payments:   number
    L35a_refund:          number
    L37_owed:             number
  }
  meta: {
    effective_rate:    number
    marginal_rate:     number
    qbi_saved:         number
    ltcg_tax:          number
    niit:              number
    se_tax_detail:     { se_tax: number; deduction: number }
    source:            string
  }
}

export function calc1040Full(inp: Form1040_Full): Form1040_Result {
  const t = TAX_TABLES[inp.tax_year]
  if (!t) throw new Error(`No tax table for year ${inp.tax_year}`)
  const s = inp.filing_status

  // ── Lines 1-8: Income ──────────────────────────────────────
  const L1z = inp.wages
  const L2b = inp.taxable_interest
  const L3b = inp.ordinary_dividends
  const L4b = inp.taxable_ira
  const L5b = inp.taxable_pensions
  // §86 Social Security taxability — up to 85% included (simplified)
  const ss_threshold_single = 34000, ss_threshold_mfj = 44000
  const ss_threshold = s === 'mfj' ? ss_threshold_mfj : ss_threshold_single
  const L6b = Math.min(inp.social_security_gross * 0.85,
                Math.max(0, inp.social_security_gross * 0.50 + 
                  Math.max(0, inp.wages + inp.taxable_interest + inp.ordinary_dividends
                    - ss_threshold) * 0.50))
  const L7  = inp.net_capital_gain
  const L8  = inp.schedule1_other_income + inp.k1_ordinary_income + inp.k1_net_rental
              + inp.net_se_income

  const L9  = L1z + L2b + L3b + L4b + L5b + L6b + L7 + L8  // Total income

  // ── Schedule 1 Part II: Above-the-line deductions ─────────
  const se = seTax(inp.net_se_income)
  const se_deduct = inp.se_tax_deduction ?? se.deduction
  const educator  = Math.min(inp.educator_expenses, t.educator_expense)
  const sl_interest = Math.min(inp.student_loan_interest, t.student_loan_interest_max)
  const L10 = se_deduct + educator + sl_interest + inp.ira_deduction  // Adjustments

  const L11 = L9 - L10  // AGI

  // ── Lines 12-15: Deductions ────────────────────────────────
  const std_ded = t.standard_deduction[s]
  const L12 = inp.use_itemized ? Math.max(inp.itemized_deductions, std_ded) : std_ded
  
  const tentative_taxable = Math.max(0, L11 - L12)
  const qbi = qbiDeduction(
    inp.k1_ordinary_income + inp.net_se_income * 0.9235,
    inp.k1_w2_wages,
    inp.k1_ubia,
    tentative_taxable,
    s, inp.tax_year
  )
  const L13 = qbi
  const L14 = L12 + L13
  const L15 = Math.max(0, L11 - L14)  // Taxable income

  // ── Lines 16-17: Tax ───────────────────────────────────────
  // Ordinary tax (excluding LTCG which is taxed separately)
  const ordinary_taxable = Math.max(0, L15 - inp.ltcg_portion - inp.qualified_dividends)
  const ordinary_tax = ordinaryTax(ordinary_taxable, s, inp.tax_year)
  const ltcg_tax = ltcgTax(inp.ltcg_portion + inp.qualified_dividends,
                            ordinary_taxable, s, inp.tax_year)
  const L16 = ordinary_tax + ltcg_tax  // Line 16

  // AMT (simplified — use ordinary income as AMTI proxy; full calc needs Form 6251)
  const amti_approx = L15 + (inp.qualified_dividends * 0 /* add back preferences */)
  const L17 = Math.max(0, amtTax(amti_approx, s === 'mfs' ? 'mfs' : s === 'mfj' ? 'mfj' : 'single',
                                  inp.tax_year) - L16)

  // ── Schedule 2: Other taxes ────────────────────────────────
  const niit = niitTax(
    inp.taxable_interest + inp.ordinary_dividends + inp.net_capital_gain + inp.k1_net_rental,
    L11,
    s === 'mfs' ? 'mfs' : s === 'mfj' ? 'mfj' : 'single',
    inp.tax_year
  )
  const L24 = se.se_tax  // SE tax
  const L25_sched2 = niit + L24  // Total Schedule 2 taxes

  const L22 = L16 + L17 + niit  // Total tax before payments

  // ── Credits ────────────────────────────────────────────────
  const ctc = inp.child_tax_credit_manual ??
    childTaxCredit(inp.num_dependents, L11, s, inp.tax_year).credit
  const L27 = Math.min(ctc, L22)  // Can't exceed tax (non-refundable portion)

  // ── Payments ───────────────────────────────────────────────
  const L25a = inp.federal_withholding
  const L26  = inp.estimated_payments
  const L33  = L25a + L26 + (ctc - L27)  // Include refundable CTC

  const net = L22 - L27 - L33
  const L35a = Math.max(0, -net)  // Refund
  const L37  = Math.max(0,  net)  // Owed

  const eff_rate = L11 > 0 ? Math.round(L22 / L11 * 1000) / 10 : 0
  // Marginal rate: find bracket for last dollar of ordinary income
  const brk = t.brackets[s]
  let marginal = 0.10
  for (const [floor, rate] of brk) {
    if (L15 > floor) marginal = rate
  }

  return {
    lines: {
      L1z_wages: L1z, L2b_taxable_interest: L2b, L3b_ord_dividends: L3b,
      L4b_ira_taxable: L4b, L5b_pension_taxable: L5b, L6b_ss_taxable: Math.round(L6b),
      L7_cap_gain: L7, L8_other_income: L8, L9_total_income: L9,
      L10_adjustments: L10, L11_agi: L11, L12_deduction: L12,
      L13_qbi_deduction: L13, L14_total_deductions: L14, L15_taxable_income: L15,
      L16_tax: L16, L17_amt: L17, L22_total_tax: L22, L24_se_tax: L24,
      L25_total_sched2: L25_sched2, L25a_withholding: L25a, L26_estimated: L26,
      L27_ctc: L27, L33_total_payments: L33, L35a_refund: L35a, L37_owed: L37,
    },
    meta: {
      effective_rate: eff_rate,
      marginal_rate: marginal,
      qbi_saved: L13,
      ltcg_tax,
      niit,
      se_tax_detail: se,
      source: `IRS Rev. Proc. 2023-34 (TY${inp.tax_year}); IRC §1, §63, §199A, §1411, §1402`,
    },
  }
}
