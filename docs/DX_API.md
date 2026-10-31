# MyRx DX exchange API: connecting MyRx EMR and labs

DX is how an investigation order gets from MyRx EMR to one or more labs, and how
their results get back into the patient's record. Every call acts for one
organisation: `/dx/orgs/:orgId/...`.

> Every call sends an API key: `Authorization: Bearer mrxk_...`. A key is issued to one
> user in one organisation (normally an `integration_service` user), works only for that
> organisation's URLs, and acts with that user's current roles. A missing, unknown,
> revoked or expired key gets 401; a key used on another organisation's URL gets 403.
> Keys are shown once when created. Organisation admins manage them with
> `GET/POST /dx/orgs/:orgId/api-keys` and `POST /dx/orgs/:orgId/api-keys/:keyId/revoke`;
> the first key comes from `npm run auth -- create-api-key` (see the README).

## The flow

```
MyRx EMR                      MyRx DX                          Lab
   |  POST /orders  ─────────▶ order + items                     |
   |  (item may name a lab)    assignment "offered"  ─────────▶  GET /work
   |                                                 ◀─────────  POST /assignments/:id/accept (or /reject)
   |                           result set + report v1 ◀────────  POST /assignments/:id/results
   |                           release decision      ◀─────────  (held / authorised / restricted)
   |  GET /results/feed ◀───── "available" entries
```

## For MyRx EMR

| Call | What it does |
| --- | --- |
| `POST /dx/orgs/:clinicId/orders` | Send an order. Safe to resend: the same `source_system` + `source_order_id` returns the existing order (200) instead of creating another (201). An item can name a `lab_service_offer_id` to go straight to a lab, e.g. the chamber's own diagnostic centre. |
| `GET /dx/offers?code=MYRX-LAB-GLU` | Labs offering an investigation, cheapest first, for the doctor or patient to choose from. |
| `POST /dx/orgs/:clinicId/orders/:orderId/items/:itemId/assign` | Send one waiting investigation to the chosen lab. Refused (409) while another lab has it. |
| `GET /dx/orgs/:clinicId/orders/:orderId` | Consolidated status: each investigation, which lab has it, and `result_state` = `pending`, `awaiting_release` or `available` (with results). |
| `GET /dx/orgs/:clinicId/results/feed?cursor=N` | Everything new since your last call. See below. |
| `GET /dx/orgs/:clinicId/patients/results?system=…&value=…` | Current results for one patient, latest version of each investigation. |

### Keeping the EMR up to date with the feed

1. Start with `cursor=0`. Save `next_cursor` from each response and send it next time.
2. Call every minute or two. If `has_more` is true, call again straight away.
3. Each entry is one of:
   - `available`: the lab authorised this report version. Store its `results` against
     `source_order_id` / `order_item_id`. If `supersedes_report_version_id` is set, it
     replaces that earlier version (a corrected report).
   - `withdrawn`: the lab held back or restricted a version it had authorised. Hide it.
4. Reports a lab is holding (for example, until the bill is paid) never appear in the feed
   until the lab authorises them.

Results are passed through exactly as the lab sent them: value, unit, reference range
and flag. DX does not change them.

## For labs

Labs running MyRx LIS Lite do not call these directly: their DX work appears in the LIS
inbox (`GET /labs/:labId/dx/inbox`, `POST /labs/:labId/dx/import`), and releasing a report
in the LIS sends the results to DX automatically. Labs with their own LIS use the calls below.


| Call | What it does |
| --- | --- |
| `GET /dx/orgs/:labId/work` | Your work queue: only investigations assigned to your lab, urgent first, with the patient's identity reference and your local test code. |
| `POST /dx/orgs/:labId/assignments/:id/accept` | Take the work; optionally send your accession number. |
| `POST /dx/orgs/:labId/assignments/:id/reject` | Decline with a reason; the investigation goes back for another lab. |
| `POST /dx/orgs/:labId/assignments/:id/results` | Send results and the report. Send a unique `idempotency_key` per message: a retry with the same key returns the first outcome (200) and never duplicates. Each submission is a new report version. Include `release` to hold the report (for example `{"decision":"held","reason_code":"awaiting_payment"}`); otherwise it is authorised. |
| `POST /dx/orgs/:labId/reports/:reportVersionId/release` | Change who may receive a report: authorise it once paid, or restrict it. |

Asking for another lab's assignment returns 404, exactly as if it did not exist, and is
recorded in `audit_events` as denied.
