import {
  validateSuccessfulTransaction,
  validateTransactionIdentity,
  type PaystackTransaction,
  type PendingPayment,
} from './paystack.ts'

export type PaymentReconciliationRow = PendingPayment & { status: string }

export type PaymentReconciliationDependencies = {
  verifyTransaction: (reference: string) => Promise<PaystackTransaction>
  markFailed: (paymentId: string) => Promise<void>
  finalize: (input: {
    paymentId: string
    providerReference: string
    transactionId: string
    amountMinor: number
    currency: string
    providerFeeMinor: number | null
    netAmountMinor: number | null
  }) => Promise<void>
}

/** Reconcile browser-return/status polling from Paystack's API, never its URL. */
export async function reconcilePaystackPayment(
  payment: PaymentReconciliationRow,
  dependencies: PaymentReconciliationDependencies,
): Promise<'skipped' | 'pending' | 'failed' | 'finalized'> {
  if (!['pending', 'failed'].includes(payment.status)) return 'skipped'
  const reference = payment.provider_reference ?? payment.internal_reference
  const transaction = await dependencies.verifyTransaction(reference)

  if (transaction.status === 'success') {
    const verified = validateSuccessfulTransaction(transaction, payment)
    await dependencies.finalize({
      paymentId: payment.id,
      providerReference: reference,
      ...verified,
    })
    return 'finalized'
  }

  if (transaction.status === 'failed' || transaction.status === 'abandoned') {
    validateTransactionIdentity(transaction, payment)
    await dependencies.markFailed(payment.id)
    return 'failed'
  }

  return 'pending'
}
