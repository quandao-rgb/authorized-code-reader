import { describe, expect, it } from "vitest";
import {
  extractAuthorizedLoginCode,
  isAllowedSender,
} from "../src/server/extract-authorized-login-code.js";

const keywords = ["login code", "verification code", "mã đăng nhập", "mã xác minh"];

describe("authorized login-code extraction", () => {
  it("extracts English and Vietnamese four-digit login codes", () => {
    expect(
      extractAuthorizedLoginCode({
        text: "Your login code is 4826. It expires soon.",
        loginKeywords: keywords,
      }),
    ).toBe("4826");
    expect(
      extractAuthorizedLoginCode({
        text: "Mã đăng nhập của bạn là 7319.",
        loginKeywords: keywords,
      }),
    ).toBe("7319");
  });

  it("parses a code from HTML", () => {
    expect(
      extractAuthorizedLoginCode({
        html: "<main><p>Your verification code:</p><strong>2468</strong></main>",
        loginKeywords: keywords,
      }),
    ).toBe("2468");
  });

  it("prefers the number nearest to the login keyword", () => {
    expect(
      extractAuthorizedLoginCode({
        text: "Reference 7777. Your login code is 1357.",
        loginKeywords: keywords,
      }),
    ).toBe("1357");
  });

  it("rejects years, dates, prices, order numbers, and unrelated numbers", () => {
    expect(
      extractAuthorizedLoginCode({
        text: "Your login code will be available in 2026.",
        loginKeywords: keywords,
      }),
    ).toBeNull();
    expect(
      extractAuthorizedLoginCode({
        text: "Verification code requested on 12/08/2025.",
        loginKeywords: keywords,
      }),
    ).toBeNull();
    expect(
      extractAuthorizedLoginCode({
        text: "Verification code notice. Total: 4500 VND.",
        loginKeywords: keywords,
      }),
    ).toBeNull();
    expect(
      extractAuthorizedLoginCode({
        text: "Verification code notice for order 9876.",
        loginKeywords: keywords,
      }),
    ).toBeNull();
    expect(
      extractAuthorizedLoginCode({
        text: "This message contains 8642 but no configured phrase.",
        loginKeywords: keywords,
      }),
    ).toBeNull();
  });

  it.each([
    "Reset your password with verification code 1234.",
    "Account recovery login code: 1234.",
    "Security alert. Your verification code is 1234.",
    "Đổi mật khẩu bằng mã xác minh 1234.",
  ])("rejects a sensitive account-flow message: %s", (text) => {
    expect(extractAuthorizedLoginCode({ text, loginKeywords: keywords })).toBeNull();
  });
});

describe("sender allowlist", () => {
  it("accepts exact senders or exact domains only", () => {
    expect(
      isAllowedSender(
        ["LOGIN-CODE@ADMIN-SERVICE.EXAMPLE"],
        ["login-code@admin-service.example"],
        [],
      ),
    ).toBe(true);
    expect(
      isAllowedSender(["different@admin-service.example"], [], ["admin-service.example"]),
    ).toBe(true);
    expect(
      isAllowedSender(
        ["attacker@not-admin-service.example"],
        [],
        ["admin-service.example"],
      ),
    ).toBe(false);
  });
});
