/**
 * Detaching deleted transactions from the return that covered them.
 *
 * A Return is not just a label. It keeps its own copy of the transaction ids it covers, and a
 * `total` that createBulkTransactions incremented once per expense as those rows were added. Delete
 * a transaction without reversing both and the return keeps a reference to a row that no longer
 * exists, and claims a total larger than the sum of what it actually covers. Nothing recomputes
 * that number, so it would simply be wrong from then on — and it is the number that says what
 * somebody owes.
 *
 * Pure, so the arithmetic can be tested without a database, which is where the risk is: the
 * subtraction has to mirror the addition exactly, including only counting expenses.
 */

/**
 * Work out what a return should look like once some of its transactions are gone.
 *
 * @param {object} returnDoc  the return, read from the database
 * @param {Array<object>} deleted  the transactions about to be deleted, already filtered to this
 *                                 return — each needs `_id`, `amount`, `transactionType` and
 *                                 optionally `tellerTransactionId`
 * @returns {{returnedTransactionIds: string[], returnedTellerTransactionIds: string[],
 *            total: number, removedFromTotal: number}}
 */
function planReturnUnlink(returnDoc, deleted = []) {
  const goneIds = new Set(deleted.map((d) => String(d._id)));
  const goneUpstream = new Set(
    deleted.map((d) => d.tellerTransactionId).filter(Boolean).map(String)
  );

  const returnedTransactionIds = (returnDoc.returnedTransactionIds || [])
    .map(String)
    .filter((id) => !goneIds.has(id));

  const returnedTellerTransactionIds = (returnDoc.returnedTellerTransactionIds || [])
    .map(String)
    .filter((id) => !goneUpstream.has(id));

  // Mirrors createBulkTransactions, which only ever added an expense to the total. Subtracting an
  // income row here would move the total in the wrong direction by twice its value.
  const removedFromTotal = deleted
    .filter((d) => d.transactionType === 'expense')
    .reduce((sum, d) => {
      const amount = Number(d.amount);
      return Number.isFinite(amount) ? sum + amount : sum;
    }, 0);

  const current = Number(returnDoc.total);
  const total = (Number.isFinite(current) ? current : 0) - removedFromTotal;

  return {
    returnedTransactionIds,
    returnedTellerTransactionIds,
    // Guard against binary-floating-point crumbs: 100.10 - 20.20 is 79.89999999999999, and a total
    // is money.
    total: Math.round(total * 100) / 100,
    removedFromTotal: Math.round(removedFromTotal * 100) / 100,
  };
}

module.exports = { planReturnUnlink };
