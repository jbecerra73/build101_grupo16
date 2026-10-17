// Simulated payment processor for the demo. No real payment is made and
// no card data leaves the browser.

export type CardBrand = "visa" | "mastercard" | "amex" | "unknown";

export type PaymentFailureCode =
  | "card_declined"
  | "insufficient_funds"
  | "expired_card"
  | "processing_error";

export type PaymentResult =
  | { ok: true; transactionId: string }
  | { ok: false; code: PaymentFailureCode; message: string };

export const TEST_CARDS: {
  number: string;
  label: string;
  failure?: PaymentFailureCode;
}[] = [
  { number: "4242424242424242", label: "Payment succeeds" },
  { number: "4000000000000002", label: "Card declined", failure: "card_declined" },
  { number: "4000000000009995", label: "Insufficient funds", failure: "insufficient_funds" },
  { number: "4000000000000069", label: "Expired card", failure: "expired_card" },
  { number: "4000000000000119", label: "Processing error", failure: "processing_error" },
];

const FAILURE_MESSAGES: Record<PaymentFailureCode, string> = {
  card_declined: "Your card was declined by the issuing bank.",
  insufficient_funds: "Your card has insufficient funds for this purchase.",
  expired_card: "Your card has expired according to the issuing bank.",
  processing_error:
    "An error occurred while processing your card. No charge was made.",
};

export const digitsOnly = (value: string) => value.replace(/\D/g, "");

export const getCardBrand = (cardNumber: string): CardBrand => {
  const digits = digitsOnly(cardNumber);
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  return "unknown";
};

export const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  unknown: "Card",
};

export const formatCardNumber = (value: string) => {
  const digits = digitsOnly(value);
  if (getCardBrand(digits) === "amex") {
    return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)]
      .filter(Boolean)
      .join(" ");
  }
  return (digits.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
};

export const formatExpiry = (value: string) => {
  const digits = digitsOnly(value).slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
};

const passesLuhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
};

export const isValidCardNumber = (value: string) => {
  const digits = digitsOnly(value);
  const length = getCardBrand(digits) === "amex" ? 15 : 16;
  return digits.length === length && passesLuhn(digits);
};

export const isValidExpiry = (value: string, now = new Date()) => {
  const match = /^(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;
  // Cards are valid through the last day of their expiry month
  return new Date(year, month, 1) > now;
};

export const isValidCvc = (value: string, cardNumber: string) =>
  digitsOnly(value).length === (getCardBrand(cardNumber) === "amex" ? 4 : 3) &&
  digitsOnly(value).length === value.length;

const randomId = (prefix: string, length: number) =>
  `${prefix}${Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .toUpperCase()
    .padEnd(length, "0")}`;

export const generateOrderId = () => randomId("SC-", 8);

export const simulatePayment = async (
  cardNumber: string,
  delayMs = 1800
): Promise<PaymentResult> => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const failure = TEST_CARDS.find(
    (card) => card.number === digitsOnly(cardNumber)
  )?.failure;

  if (failure) {
    return { ok: false, code: failure, message: FAILURE_MESSAGES[failure] };
  }

  return { ok: true, transactionId: randomId("txn_", 12) };
};
