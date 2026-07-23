import { htmlToText } from "html-to-text";

export interface LoginCodeMessage {
  subject?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  loginKeywords: string[];
}

const BLOCKED_PATTERNS = [
  /reset\s+(?:your\s+)?password/i,
  /forgot\s+(?:your\s+)?password/i,
  /recover(?:y|ing)?\s+(?:your\s+)?account/i,
  /account\s+recovery/i,
  /change\s+(?:your\s+)?password/i,
  /update\s+(?:your\s+)?email/i,
  /change\s+(?:your\s+)?(?:email|phone|mobile)/i,
  /security\s+(?:alert|warning)/i,
  /suspicious\s+activity/i,
  /new\s+device\s+(?:approval|request)/i,
  /remove\s+(?:two-factor|2fa)/i,
  /payment|billing\s+change/i,
  /đổi\s+mật\s+khẩu/i,
  /quên\s+mật\s+khẩu/i,
  /khôi\s+phục\s+tài\s+khoản/i,
  /thay\s+đổi\s+(?:email|số\s+điện\s+thoại)/i,
  /cảnh\s+báo\s+bảo\s+mật/i,
  /hoạt\s+động\s+đáng\s+ngờ/i,
];

const ORDER_MARKERS =
  /order|invoice|receipt|tracking|booking|đơn\s+hàng|hóa\s+đơn|mã\s+đơn/i;
const CURRENCY_MARKERS = /(?:[$€£¥₫]|usd|eur|gbp|vnd|đồng)/i;

function distanceFromKeyword(
  position: number,
  text: string,
  keywords: string[],
): number | null {
  let shortest = Number.POSITIVE_INFINITY;
  for (const keyword of keywords) {
    const normalizedKeyword = keyword.trim().toLowerCase();
    if (!normalizedKeyword) {
      continue;
    }

    let index = text.indexOf(normalizedKeyword);
    while (index >= 0) {
      const keywordMiddle = index + normalizedKeyword.length / 2;
      shortest = Math.min(shortest, Math.abs(position - keywordMiddle));
      index = text.indexOf(normalizedKeyword, index + normalizedKeyword.length);
    }
  }

  return Number.isFinite(shortest) ? shortest : null;
}

function looksLikeUnrelatedNumber(code: string, position: number, text: string): boolean {
  const numeric = Number(code);
  if (numeric >= 1900 && numeric <= 2099) {
    return true;
  }

  const nearby = text.slice(Math.max(0, position - 40), position + code.length + 40);
  const compact = nearby.replace(/[^\d]/g, "");

  if (
    new RegExp(`(?:\\d{1,2}[./-]){2}${code}|${code}(?:[./-]\\d{1,2}){2}`).test(nearby)
  ) {
    return true;
  }

  if (CURRENCY_MARKERS.test(nearby) || ORDER_MARKERS.test(nearby)) {
    return true;
  }

  if (compact.length >= 7 && /(?:phone|tel|hotline|điện\s+thoại|sđt)/i.test(nearby)) {
    return true;
  }

  return false;
}

export function extractAuthorizedLoginCode(message: LoginCodeMessage): string | null {
  const htmlText = message.html
    ? htmlToText(message.html, {
        wordwrap: false,
        selectors: [{ selector: "a", options: { ignoreHref: true } }],
      })
    : "";
  const combined = [message.subject ?? "", message.text ?? "", htmlText]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!combined || BLOCKED_PATTERNS.some((pattern) => pattern.test(combined))) {
    return null;
  }

  const normalized = combined.toLowerCase();
  const keywords = message.loginKeywords.map((keyword) => keyword.toLowerCase());
  if (!keywords.some((keyword) => normalized.includes(keyword))) {
    return null;
  }

  const candidates = [...normalized.matchAll(/\b\d{4}\b/g)]
    .map((match) => {
      const position = match.index ?? -1;
      const code = match[0];
      const distance = distanceFromKeyword(position, normalized, keywords);
      return { code, position, distance };
    })
    .filter(
      (candidate) =>
        candidate.position >= 0 &&
        candidate.distance !== null &&
        candidate.distance <= 80 &&
        !looksLikeUnrelatedNumber(candidate.code, candidate.position, normalized),
    )
    .sort(
      (left, right) =>
        (left.distance ?? Number.POSITIVE_INFINITY) -
          (right.distance ?? Number.POSITIVE_INFINITY) || left.position - right.position,
    );

  return candidates[0]?.code ?? null;
}

export function isAllowedSender(
  senderAddresses: string[],
  allowedSenders: string[],
  allowedSenderDomains: string[],
): boolean {
  const addressSet = new Set(allowedSenders.map((sender) => sender.toLowerCase()));
  const domainSet = new Set(
    allowedSenderDomains.map((domain) => domain.replace(/^@/, "").toLowerCase()),
  );

  return senderAddresses.some((sender) => {
    const normalized = sender.trim().toLowerCase();
    const domain = normalized.split("@").at(-1);
    return addressSet.has(normalized) || (domain ? domainSet.has(domain) : false);
  });
}
