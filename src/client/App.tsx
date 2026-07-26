import {
  Check,
  Clipboard,
  Clock3,
  KeyRound,
  LoaderCircle,
  Mail,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

type ViewState =
  "idle" | "connecting" | "waiting" | "found" | "timeout" | "not_found" | "error";

interface CreationResponse {
  status: "waiting" | "not_found" | "busy" | "error";
  requestId?: string;
  expiresAt?: string;
  message?: string;
}

interface StatusResponse {
  status: "waiting" | "found" | "timeout" | "error";
  remainingSeconds?: number;
  code?: string;
  message?: string;
}

const FIVE_MINUTES_SECONDS = 5 * 60;
const COPY_RESET_MS = 2_000;

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function App() {
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [view, setView] = useState<ViewState>("idle");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(FIVE_MINUTES_SECONDS);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const pollBusy = useRef(false);

  useEffect(() => {
    if (view !== "waiting" || !requestId || !expiresAt) {
      return;
    }

    let stopped = false;
    const controller = new AbortController();

    const updateCountdown = (): void => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
      setRemainingSeconds(seconds);
      if (seconds === 0) {
        setView("timeout");
        setMessage("Không tìm thấy mã. Hãy thử lại.");
      }
    };

    const poll = async (): Promise<void> => {
      if (stopped || pollBusy.current) {
        return;
      }
      pollBusy.current = true;
      try {
        const response = await fetch(`/api/code-requests/${requestId}`, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const data = (await response.json()) as StatusResponse;
        if (stopped) {
          return;
        }

        if (data.status === "found" && data.code) {
          setCode(data.code);
          setView("found");
          setMessage("Đã tìm thấy mã");
        } else if (data.status === "timeout") {
          setView("timeout");
          setMessage(data.message ?? "Không tìm thấy mã. Hãy thử lại.");
        } else if (!response.ok || data.status === "error") {
          setView("error");
          setMessage(data.message ?? "Không thể kiểm tra hộp thư. Hãy thử lại sau.");
        } else if (typeof data.remainingSeconds === "number") {
          setRemainingSeconds(data.remainingSeconds);
        }
      } catch {
        if (!controller.signal.aborted) {
          setView("error");
          setMessage("Không thể kiểm tra hộp thư. Hãy thử lại sau.");
        }
      } finally {
        pollBusy.current = false;
      }
    };

    updateCountdown();
    void poll();
    const countdownTimer = window.setInterval(updateCountdown, 1_000);
    const pollingTimer = window.setInterval(() => void poll(), 2_000);

    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(countdownTimer);
      window.clearInterval(pollingTimer);
      pollBusy.current = false;
    };
  }, [expiresAt, requestId, view]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!email.trim() || view === "connecting" || view === "waiting") {
      return;
    }

    setView("connecting");
    setMessage("Đang kết nối hộp thư...");
    setCode("");
    setCopied(false);

    try {
      const response = await fetch("/api/code-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await response.json()) as CreationResponse;

      if (response.status === 404 || data.status === "not_found") {
        setView("not_found");
        setMessage(data.message ?? "Không tìm thấy email.");
        return;
      }

      if (!response.ok || data.status !== "waiting" || !data.requestId) {
        setView("error");
        setMessage(data.message ?? "Không thể kiểm tra hộp thư. Hãy thử lại sau.");
        return;
      }

      const expiry = data.expiresAt
        ? new Date(data.expiresAt).getTime()
        : Date.now() + FIVE_MINUTES_SECONDS * 1_000;
      setRequestId(data.requestId);
      setExpiresAt(expiry);
      setRemainingSeconds(Math.max(0, Math.ceil((expiry - Date.now()) / 1_000)));
      setView("waiting");
      setMessage("Đang chờ mã đăng nhập...");
    } catch {
      setView("error");
      setMessage("Không thể kiểm tra hộp thư. Hãy thử lại sau.");
    }
  };

  const cancel = async (): Promise<void> => {
    const currentRequestId = requestId;
    setRequestId(null);
    setExpiresAt(null);
    setView("idle");
    setMessage("");
    setRemainingSeconds(FIVE_MINUTES_SECONDS);

    if (currentRequestId) {
      try {
        await fetch(`/api/code-requests/${currentRequestId}`, {
          method: "DELETE",
          cache: "no-store",
        });
      } catch {
        // The local interface is reset even if the server is no longer reachable.
      }
    }
  };

  const reset = (): void => {
    setRequestId(null);
    setExpiresAt(null);
    setView("idle");
    setMessage("");
    setCode("");
    setCopied(false);
    setRemainingSeconds(FIVE_MINUTES_SECONDS);
  };

  const copyCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_RESET_MS);
    } catch {
      setCopied(false);
    }
  };

  const isBusy = view === "connecting" || view === "waiting";
  const showResult = ["found", "timeout", "not_found", "error"].includes(view);

  return (
    <main className="app-shell">
      <div className="ambient" aria-hidden="true">
        <div className="ambient__arc ambient__arc--top" />
        <div className="ambient__arc ambient__arc--bottom" />
        <div className="ambient__orb ambient__orb--left" />
        <div className="ambient__orb ambient__orb--right" />
        <div className="ambient__slashes ambient__slashes--top">
          <i />
          <i />
          <i />
        </div>
        <div className="ambient__slashes ambient__slashes--bottom">
          <i />
          <i />
          <i />
        </div>
        <div className="ambient__grid" />
        <div className="ambient__wave" />
      </div>

      <section className="code-card" aria-labelledby="page-title">
        <div className="brand-lockup">
          <span className="brand-lockup__mark">
            <ShieldCheck size={24} strokeWidth={2} aria-hidden="true" />
          </span>
          <span>MÃ TRUY CẬP BẢO MẬT</span>
        </div>

        <header className="card-header">
          <span className="card-header__eyebrow">
            <span className="status-dot" aria-hidden="true" />
            Kết nối an toàn
          </span>
          <h1 id="page-title">Nhận mã đăng nhập</h1>
          <p>
            Nhập email đã được cấp quyền. Hệ thống sẽ chờ và hiển thị mã mới trong tối đa
            5 phút.
          </p>
        </header>

        {!showResult && (
          <form className="request-form" onSubmit={submit}>
            <label htmlFor={inputId}>Địa chỉ email</label>
            <div className="email-field">
              <Mail size={20} aria-hidden="true" />
              <input
                id={inputId}
                type="email"
                inputMode="email"
                autoComplete="email"
                maxLength={254}
                placeholder="Nhập email đã được cấp quyền"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={isBusy}
                required
              />
            </div>

            {view === "waiting" && (
              <div className="waiting-panel" aria-hidden="true">
                <div className="waiting-panel__pulse">
                  <Mail size={24} />
                </div>
                <div>
                  <span>Đang theo dõi hộp thư</span>
                  <small>Chỉ kiểm tra thư mới từ người gửi được cho phép</small>
                </div>
              </div>
            )}

            <div className="form-actions">
              <button
                className="primary-button"
                type="submit"
                disabled={isBusy || !email.trim()}
              >
                {view === "connecting" || view === "waiting" ? (
                  <LoaderCircle className="spin" size={20} aria-hidden="true" />
                ) : (
                  <KeyRound size={20} aria-hidden="true" />
                )}
                {view === "connecting"
                  ? "Đang kết nối hộp thư..."
                  : view === "waiting"
                    ? "Đang chờ mã đăng nhập..."
                    : "Nhận mã"}
              </button>

              {view === "waiting" && (
                <button className="secondary-button" type="button" onClick={cancel}>
                  <X size={18} aria-hidden="true" />
                  Hủy
                </button>
              )}
            </div>

            {view === "waiting" && (
              <div className="countdown" aria-label="Thời gian còn lại">
                <Clock3 size={17} aria-hidden="true" />
                <span>Thời gian còn lại</span>
                <strong>{formatCountdown(remainingSeconds)}</strong>
              </div>
            )}
          </form>
        )}

        {showResult && (
          <div className={`result-panel result-panel--${view}`}>
            <div className="result-panel__icon" aria-hidden="true">
              {view === "found" ? (
                <Check size={28} />
              ) : view === "timeout" ? (
                <Clock3 size={28} />
              ) : view === "not_found" ? (
                <Mail size={28} />
              ) : (
                <X size={28} />
              )}
            </div>
            <h2>{view === "found" ? "Đã tìm thấy mã" : message}</h2>

            {view === "found" && (
              <>
                <p className="result-panel__hint">
                  Mã chỉ hiển thị tạm thời. Hãy sử dụng ngay.
                </p>
                <div className="code-digits" aria-label={`Mã đăng nhập ${code}`}>
                  {code.split("").map((digit, index) => (
                    <span key={`${digit}-${index}`} aria-hidden="true">
                      {digit}
                    </span>
                  ))}
                </div>
                <button className="primary-button" type="button" onClick={copyCode}>
                  {copied ? (
                    <Check size={20} aria-hidden="true" />
                  ) : (
                    <Clipboard size={20} aria-hidden="true" />
                  )}
                  {copied ? "Đã sao chép" : "Sao chép mã"}
                </button>
              </>
            )}

            {view !== "found" && (
              <p className="result-panel__hint">
                Kiểm tra lại email hoặc thử gửi một yêu cầu mới.
              </p>
            )}

            <button className="secondary-button" type="button" onClick={reset}>
              <RefreshCw size={18} aria-hidden="true" />
              Thử lại
            </button>
          </div>
        )}

        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {copied ? "Đã sao chép mã" : message}
        </p>

        <footer className="card-footer">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Không lưu email, nội dung thư hoặc mã đăng nhập</span>
        </footer>
      </section>
    </main>
  );
}
