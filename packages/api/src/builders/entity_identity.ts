/**
 * Entity header/meta fields for a return's field_values — pure string
 * parsing, extracted from the compute persist path.
 *
 * 1040s split the entity name into first/spouse/last ("X & Y Surname"),
 * and both form families split apartment/suite designators off the street
 * address, because the PDFs have separate cells for them. `ent.ein` holds
 * the SSN for 1040 entities. Pass the DECRYPTED entity row — ein is an
 * encrypted column and this function only reads plaintext properties.
 */
export function entityIdentityFields(
  ent: any,
  form_type: string,
  engineFieldValues: Record<string, any>,
): Record<string, any> {
  const metaFields: Record<string, any> = {}
  const engineResult = { field_values: engineFieldValues }
if (ent) {
  if (form_type === '1040') {
    // 1040: split name fields — auto-parse entity.name if first/last not explicit
    let first = ent.meta?.first_name
    let last = ent.meta?.last_name
    let spouseFirst = ent.meta?.spouse_first
    let spouseLast = ent.meta?.spouse_last
    if (!first && !last && ent.name) {
      // Handle "X & Y Razzaq" or "X Razzaq" patterns
      const match = ent.name.match(/^(\S+?)(?:\s+&\s+(\S+))?\s+(.+)$/)
      if (match) {
        first = match[1]
        last = match[3]
        if (match[2]) spouseFirst = match[2]
        if (match[2] && !spouseLast) spouseLast = match[3]  // shared surname
      }
    }
    if (first) metaFields['meta.first_name'] = first
    if (last) metaFields['meta.last_name'] = last
    if (spouseFirst) metaFields['meta.spouse_first'] = spouseFirst
    if (spouseLast) metaFields['meta.spouse_last'] = spouseLast
    if (ent.ein) metaFields['meta.ssn'] = ent.ein  // "ein" holds SSN for 1040
    if (ent.meta?.spouse_ssn) metaFields['meta.spouse_ssn'] = ent.meta.spouse_ssn
    if (ent.address) {
      // Split apartment/suite off if present
      const aptMatch = ent.address.match(/^(.+?)\s+(apt|ste|suite|unit|#)\s*(.+)$/i)
      if (aptMatch) {
        metaFields['meta.address'] = aptMatch[1]
        metaFields['meta.apt'] = aptMatch[3]
      } else {
        metaFields['meta.address'] = ent.address
      }
    }
    if (ent.city) metaFields['meta.city'] = ent.city
    if (ent.state) metaFields['meta.state'] = ent.state
    if (ent.zip) metaFields['meta.zip'] = ent.zip
  } else {
    // 1120/1120S: entity_name + address (split street/suite)
    if (ent.name) metaFields['meta.entity_name'] = ent.name
    if (ent.ein) metaFields['meta.ein'] = ent.ein
    if (ent.address) {
      // Parse "SUITE/STE/ROOM/UNIT/#X" off the end of the address string
      const suiteMatch = ent.address.match(/^(.+?)\s+(?:suite|ste|room|rm|unit|#)\s*([\w-]+)\s*$/i)
      if (suiteMatch) {
        metaFields['meta.address'] = suiteMatch[1].trim()
        metaFields['meta.suite'] = suiteMatch[2].trim()
      } else {
        metaFields['meta.address'] = ent.address
      }
    }
    if (ent.meta?.suite) metaFields['meta.suite'] = ent.meta.suite  // explicit override
    if (ent.city) metaFields['meta.city'] = ent.city
    if (ent.state) metaFields['meta.state'] = ent.state
    if (ent.zip) metaFields['meta.zip'] = ent.zip
    // city_state_zip is a legacy alias for forms that have a combined field.
    // Don't map it to a numeric field ID on forms that have separate cells.
    if (ent.city || ent.state || ent.zip)
      metaFields['meta.city_state_zip'] = [ent.city, ent.state, ent.zip].filter(Boolean).join(', ')
    if (ent.date_incorporated) metaFields['meta.date_incorporated'] = ent.date_incorporated
    if (ent.meta?.business_code) {
      metaFields['meta.business_activity_code'] = ent.meta.business_code
      metaFields['meta.business_code'] = ent.meta.business_code  // 1120S canonical key
    }
    // Country defaults to "United States" for domestic corps
    metaFields['meta.country'] = ent.meta?.country || 'United States'
    if (ent.meta?.s_election_date) metaFields['meta.s_election_date'] = ent.meta.s_election_date
    if (ent.meta?.num_shareholders) metaFields['meta.num_shareholders'] = ent.meta.num_shareholders
    // meta.total_assets (form line D) — auto-populate from Schedule L
    // EOY total (schedL.L15_total_eoy_d) so the header matches the
    // balance sheet. Entity.meta.total_assets overrides if explicitly set.
    const l15Total = (engineResult?.field_values || {})['schedL.L15_total_eoy_d']
    if (ent.meta?.total_assets) {
      metaFields['meta.total_assets'] = ent.meta.total_assets
    } else if (l15Total && l15Total !== 0) {
      metaFields['meta.total_assets'] = l15Total
    }
    if (ent.meta?.business_activity) metaFields['meta.business_activity'] = ent.meta.business_activity
    if (ent.meta?.product_service) metaFields['meta.product_service'] = ent.meta.product_service
    // Title is an officer title (e.g. PRESIDENT) — only applies to business returns
    if (ent.meta?.title) metaFields['meta.title'] = ent.meta.title
  }
  // Preparer info
  const prep = ent.meta?.preparer
  if (prep) {
    if (prep.name) metaFields['preparer.name'] = prep.name
    if (prep.ptin) metaFields['preparer.ptin'] = prep.ptin
    if (prep.firm_name) metaFields['preparer.firm_name'] = prep.firm_name
    if (prep.firm_ein) metaFields['preparer.firm_ein'] = prep.firm_ein
    if (prep.firm_address) metaFields['preparer.firm_address'] = prep.firm_address
    if (prep.firm_phone || prep.phone) metaFields['preparer.firm_phone'] = prep.firm_phone || prep.phone
    if (prep.phone) metaFields['preparer.phone'] = prep.phone
  }
}
  return metaFields
}
