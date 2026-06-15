// Returns the visitor's country from Vercel's geo headers, mapped to the
// Natural Earth country name used by routes.json (so the client can preselect it).
const ISO2_TO_NAME = {
  KR: "South Korea", KP: "North Korea", US: "United States of America", CA: "Canada",
  MX: "Mexico", BR: "Brazil", AR: "Argentina", CL: "Chile", CO: "Colombia", PE: "Peru",
  EC: "Ecuador", VE: "Venezuela", BO: "Bolivia", PA: "Panama", GT: "Guatemala",
  CU: "Cuba", DO: "Dominican Rep.", JM: "Jamaica", HT: "Haiti", HN: "Honduras",
  NI: "Nicaragua", SV: "El Salvador", PR: "Puerto Rico",
  GB: "United Kingdom", IE: "Ireland", FR: "France", DE: "Germany", ES: "Spain",
  PT: "Portugal", IT: "Italy", NL: "Netherlands", BE: "Belgium", CH: "Switzerland",
  AT: "Austria", GR: "Greece", TR: "Turkey", PL: "Poland", CZ: "Czechia", SE: "Sweden",
  NO: "Norway", DK: "Denmark", FI: "Finland", RU: "Russia", UA: "Ukraine", RO: "Romania",
  HU: "Hungary", CN: "China", JP: "Japan", IN: "India", ID: "Indonesia", TH: "Thailand",
  MY: "Malaysia", SG: "Singapore", PH: "Philippines", VN: "Vietnam", BD: "Bangladesh",
  PK: "Pakistan", LK: "Sri Lanka", AE: "United Arab Emirates", SA: "Saudi Arabia",
  QA: "Qatar", KW: "Kuwait", IL: "Israel", IR: "Iran", IQ: "Iraq", JO: "Jordan",
  EG: "Egypt", MA: "Morocco", DZ: "Algeria", TN: "Tunisia", ZA: "South Africa",
  NG: "Nigeria", KE: "Kenya", ET: "Ethiopia", GH: "Ghana", TZ: "Tanzania",
  SN: "Senegal", AU: "Australia", NZ: "New Zealand", FJ: "Fiji", PG: "Papua New Guinea",
  HK: "China", TW: "Taiwan",
};

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const iso = (req.headers["x-vercel-ip-country"] || "").toUpperCase();
  res.status(200).json({ iso2: iso || null, name: ISO2_TO_NAME[iso] || null });
};
