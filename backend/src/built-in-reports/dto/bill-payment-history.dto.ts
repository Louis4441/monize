export class BillPaymentItem {
  scheduledTransactionId: string;
  scheduledTransactionName: string;
  payeeName: string;
  totalPaid: number;
  paymentCount: number;
  averagePayment: number;
  lastPaymentDate: string | null;
}

export class MonthlyBillTotal {
  /**
   * The month as structure (`YYYY-MM`), and the only form it travels in. A
   * `label` field beside it carried an `en-US` `Mmm YY` string, which was
   * English in all 22 locales; the client renders this key through the user's
   * own date preference. Do not add a display string here -- a formatted month
   * on the wire is a month formatted for the wrong reader.
   */
  month: string;
  total: number;
}

export class BillPaymentSummary {
  totalPaid: number;
  totalPayments: number;
  uniqueBills: number;
  monthlyAverage: number;
}

export class BillPaymentHistoryResponse {
  billPayments: BillPaymentItem[];
  monthlyTotals: MonthlyBillTotal[];
  summary: BillPaymentSummary;
}
