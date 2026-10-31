# Roadmap

| Phase | Goal | Scope | Done when |
| --- | --- | --- | --- |
| 0. Shared foundation | One platform for LIS and DX | Repo, migrations, automated tests, CI, API skeleton; import the DX schema and its tests | Schema and tests run from a clean checkout in CI |
| 1. LIS Lite MVP | A small lab can run its day on it | Registration, referring doctors, test catalogue and prices, billing (optional), barcode labels, sample tracking, result entry with ranges and flags, validation and release, Bangla/English PDF report, daily summary, audit | One synthetic patient goes from registration to a printed, released report |
| 2. DX hookup | LIS acts as a connected lab | Pull assigned DX order items, post authorised reports back as versioned results, respect the lab's release policy | One order split across two labs shows consolidated results in the EMR |
| 3. LIS Standard | Medium centres | Department routing, worklists, two-step validation, referral-lab tracking, amended reports, online report delivery, basic QC | First pilot lab runs a full week on it |
| 4. LIS Enterprise | Chains | Multi-branch, central catalogue and pricing, analyser interfaces (ASTM/HL7), Levey-Jennings and Westgard QC, FHIR and LOINC export | Second branch or analyser live |

## Status

- [x] Phase 0: repo, migration runner, CI, API skeleton
- [x] Phase 0: MyRx DX schema imported (migrations 0002–0005) with its tests ported
- [x] Phase 1: LIS Lite data model (migration 0001) with database tests
- [x] Phase 1: LIS Lite API (registration, orders, billing, specimens, results, validation, release, daily summary)
- [x] Phase 2 (moved up): DX result-delivery path: EMR order intake, lab work queue, result intake, EMR result feed
- [x] Bridge: DX orders appear in the LIS Lite inbox; LIS releases and payment-based authorisations flow back to DX automatically
- [ ] Adapter for labs with their own LIS (BIRDEM-style pull API)
- [ ] Phase 1: real login, PDF report, screens
