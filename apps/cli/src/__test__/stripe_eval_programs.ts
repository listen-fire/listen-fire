// Two programs a person asks for in plain words, written for @lf/stripe. They
// were the questions fresh agents could not answer faithfully before the module
// read charges, and they are the proof the gap is closed:
//
//   FAILED_PAYMENT: "when a customer's Stripe payment fails, post to #billing
//   with the customer's name, the amount and currency, and the reason Stripe
//   gives for the failure".
//
//   WEEKLY_CHARGES: "every Friday, post how many successful Stripe charges we
//   had in the last 7 days and their total per currency, plus the three largest
//   charges with their customer names".

const HEADER = `import { stripe, slack } from adapters
import { stripe_account, team_slack } from credentials

pay = connect stripe using stripe_account
chat = connect slack using team_slack
`;

export const FAILED_PAYMENT = `${HEADER}
function \`Payment Failed\`(e: <pay-[:InvoiceChange]->>) {
  inv = only(e-[:Invoice]->)
  if (inv == null) { fail("\${e.Type} is not about an invoice") }
  customer = only(inv-[:Customer]->)
  attempt = only(inv-[c:Charges WHERE c.Status == "failed" ORDER BY c.Created DESC LIMIT 1]->)
  reason = coalesce(attempt.\`Failure Message\`, attempt.\`Outcome Seller Message\`, "Stripe gave no reason")
  amount = Currency.formatFigure(inv.\`Amount Due\`, inv.Currency)

  billing = only(chat-[ch:Channels WHERE ch.Name == "billing"]->)
  if (billing == null) { fail("no #billing channel") }
  write billing-[:Messages]-> {
    Message: "Payment failed: \${coalesce(customer.Name, inv.\`Customer Name\`)} — \${amount} (\${inv.Currency}). Stripe says: \${reason}"
  }
}

listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]-> fire \`Payment Failed\`
`;

/** The currencies the weekly report has a line for. The language has no
 *  "distinct values of a field", so the report walks a written list of them and
 *  fails, rather than drop a charge, when one is in a currency not listed
 *  (\`unlisted\` below). */
const CURRENCIES = '"usd" | "eur" | "gbp" | "jpy"';

/** The report's body for a trigger of the given listen: Fridays at 09:00 UTC
 *  from cron, or a manual invocation (what the test runs). */
function weekly(trigger: string, listen: string): string {
  return `${HEADER}
type Money = <${CURRENCIES}>

function \`Weekly Charges\`(t: ${trigger}) {
  week = pay-[c:Charges WHERE c.Created WITHIN 7d AND c.Status == "succeeded"]->
  rows = map(week, (c) => { return { currency: c.Currency, amount: c.Amount } })
  by = List.groupBy(rows, (r) => r.currency)
  unlisted = count(rows) - List.sum(map(members(<Money>), (cur) => count(coalesce(by[cur], []))))
  if (unlisted != 0) { fail("\${unlisted} successful charges are in a currency this report has no line for") }

  lines = map(members(<Money>), (cur) => {
    mine = coalesce(by[cur], [])
    total = Number.format(List.sum(map(mine, (r) => r.amount)), "grouped")
    top = pay-[c:Charges WHERE c.Created WITHIN 7d AND c.Status == "succeeded" AND c.Currency == cur ORDER BY c.Amount DESC LIMIT 3]->
    largest = map(top, (c) => "\${coalesce(c-[:Customer]->.Name, "unknown")} \${Number.format(c.Amount, "grouped")}")
    return count(mine) == 0 ? "" : "\${Text.upper(cur)}: \${count(mine)} charges, \${total} total. Largest: \${Text.join(largest, ", ")}"
  })

  billing = only(chat-[ch:Channels WHERE ch.Name == "billing"]->)
  if (billing == null) { fail("no #billing channel") }
  write billing-[:Messages]-> {
    Message: "Last 7 days: \${count(rows)} successful charges.\\n\${Text.join(filter(lines, (l) => l != ""), "\\n")}"
  }
}

${listen}
`;
}

export const WEEKLY_CHARGES = weekly('<cron-[:Ticks]->>', 'listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 5"]-> fire `Weekly Charges`');

/** The same report body, run on demand so a test can read what it posts. */
export const WEEKLY_CHARGES_ON_DEMAND = weekly('<manual-[:Invocations]->>', 'listen to manual-[:Invocations]-> fire `Weekly Charges`');
