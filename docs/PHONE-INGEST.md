# Posting transactions from a phone

`POST /api/ingest/transaction` on the website (not the backend directly).

```
POST https://<your-site>/api/ingest/transaction
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

Send one object, or an array of them (max 100).

Every example below was run through the real builder; the "stored as" lines are actual output.

---

## The minimum

Three fields are required: `amount`, `description`, `date`.

```json
{"amount": 37.57, "description": "Zelle payment from HYEON M YANG", "date": "2026-07-25", "notes": "gas"}
```

> stored as — `income` · `+37.57` · Chase College

The description matched a rule, so type and account were filled in automatically.

```json
{"amount": 25, "description": "Zelle payment to Anna Chee", "date": "2026-07-25"}
```

> stored as — `expense` · `-25.00` · Chase College

Note the amount was sent **positive** and stored **negative**. The description decides direction;
the account decides the sign. Sending a positive number is always fine.

---

## A card purchase

```json
{
  "amount": 180.69,
  "description": "CHICAGO GALBI HOUSE",
  "date": "2026-07-20",
  "paymentMethod": "Freedom Unlimited",
  "category": "personal",
  "purchaseCategory": ["dining"]
}
```

> stored as — `expense` · `+180.69` · Freedom Unlimited · 3 points

Points were computed from the card and the purchase category. On a credit card a charge is
positive, which is why this one keeps its sign while the Zelle example above flipped.

---

## Let the existing rules classify it

```json
{"amount": 93.87, "description": "ALDI 12345", "date": "2026-02-10", "paymentMethod": "Freedom"}
```

> stored as — `expense` · `parents-monthly` · `["groceries"]` · **5 points** · linked to that month's return

The same classifiers the bank feed used. The 5 points are the Q1 grocery bonus — the identical
purchase in July earns 0, because that rule only covers months 1–3.

---

## Cash, bare minimum

```json
{"amount": 12.50, "description": "Street parking", "date": "2026-07-25"}
```

> stored as — `expense` · `-12.50` · Cash

No rule matched, so it defaults to Cash, and a bare positive amount is treated as money spent.

---

## Override everything

```json
{
  "amount": 500,
  "description": "Rent share",
  "date": "2026-07-01",
  "paymentMethod": "Chase College",
  "transactionType": "expense",
  "category": "bill",
  "purchaseCategory": [],
  "points": 0,
  "notes": "July"
}
```

> stored as — `expense` · `-500.00` · bill

Anything you state explicitly wins over the rules.

---

## A refund

```json
{"amount": -45.00, "description": "AMAZON refund", "date": "2026-07-22", "paymentMethod": "Amazon Visa"}
```

> stored as — `income` · `-45.00` · `["amazon"]`

A negative amount means money coming back.

---

## Fields

| Field | Required | Notes |
|---|---|---|
| `amount` | **yes** | Number or numeric string. Zero, `null` and non-numeric are rejected — never stored as $0. |
| `date` | **yes** | `YYYY-MM-DD` exactly. `year`, `month`, `day` are derived. |
| `description` | **yes** | Drives the rules below. |
| `notes` | no | Free text. |
| `transactionType` | no | `income` \| `expense`. Overrides the rules. |
| `paymentMethod` | no | Overrides the rules. Defaults to `Cash`. |
| `category` | no | Overrides the computed value. |
| `purchaseCategory` | no | Array. Overrides the computed value. |
| `points` | no | Overrides the computed value. |
| `allowDuplicate` | no | `true` to force a second row for a genuinely repeated purchase. |

Unknown fields are ignored, not rejected — the payload can grow harmlessly.

### Accepted values

**paymentMethod** — `Chase College` · `Freedom` · `Freedom Flex` · `Freedom Unlimited` ·
`Sapphire Reserve` · `Amazon Visa` · `Cash` · `Schwab` · `DiscoverChecking` · `Amazon Gift Card`

**category** — `fuel` · `personal` · `parents-monthly` · `parents-not monthly` · `bill` ·
`emergency` · `travel` · `offering` · `doctors` · `automobile` · `korea` · `business` · `misc` ·
`payroll`

**purchaseCategory** — `groceries` · `amazon` · `dining` · `gift` · `gift card` ·
`birthday gift` · `wedding gift` · `health` · `flight` · `hotel` · `drugstore` · `lyft` ·
`travel` · `international` · `fuel`

### Description rules

Defined in `services/manualTransaction.js` — add to `DESCRIPTION_RULES` as new patterns recur.

| Description contains | → type | → account |
|---|---|---|
| `zelle payment from` | income | Chase College |
| `zelle payment to` | expense | Chase College |

Nothing matched → `Cash`, and a positive amount means money spent.

---

## Sending several at once

```json
[
  {"amount": 12.50, "description": "Coffee", "date": "2026-07-25"},
  {"amount": 8.75,  "description": "Lunch",  "date": "2026-07-25"}
]
```

Each is validated independently. Valid ones save, invalid ones come back under `errors` with
their index — one bad entry does not discard the rest.

---

## Duplicates

The id is derived from `date + amount + description + paymentMethod`, so **resending the same
payload updates the same row instead of creating a second**. A phone retrying on a flaky
connection cannot silently double an expense.

For two genuinely identical purchases on one day, add `"allowDuplicate": true` to the second.

---

## Responses

**201** — saved:
```json
{"message": "Saved 1 transaction(s).", "created": 1, "updated": 0, "transactions": [ ... ]}
```
A retry returns `"created": 0, "updated": 1`.

**400** — nothing saved; `errors` says which entry and why.
**401** — token missing or wrong.
**503** — `INGEST_TOKEN` is not configured on the server.

---

## Curl

```bash
curl -X POST https://<your-site>/api/ingest/transaction \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"amount":37.57,"description":"Zelle payment from HYEON M YANG","date":"2026-07-25","notes":"gas"}'
```

## iOS Shortcut

**Get Contents of URL** → your site's `/api/ingest/transaction` → Method `POST` →
Headers `Authorization: Bearer <token>` → Request Body **JSON** with `amount` (Number),
`description` (Text), `date` (Text), `notes` (Text).

For today's date, use a **Format Date** action with format `yyyy-MM-dd`.

The token is a password: anyone holding it can add rows to your ledger. It cannot read your
bank data or delete anything, and it can be rotated on its own without logging you out.
