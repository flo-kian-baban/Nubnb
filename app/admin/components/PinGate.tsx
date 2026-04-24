"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Lock } from "lucide-react";
import styles from "./PinGate.module.css";

const PIN_LENGTH = 4;

interface PinGateProps {
  children: React.ReactNode;
}

export function PinGate({ children }: PinGateProps) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Check session cookie validity on mount via server-side verification
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin-auth", { method: "GET" })
      .then((res) => {
        if (!cancelled) setIsAuthenticated(res.ok);
      })
      .catch(() => {
        if (!cancelled) setIsAuthenticated(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Auto-focus first input when gate is shown
  useEffect(() => {
    if (isAuthenticated === false) {
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    }
  }, [isAuthenticated]);

  const handleVerify = useCallback(async (pin: string) => {
    setIsVerifying(true);
    setError("");

    try {
      const res = await fetch("/api/admin-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (res.ok) {
        // Cookie is set by the server — no client-side storage needed
        setIsAuthenticated(true);
      } else {
        setError("Incorrect PIN");
        setDigits(Array(PIN_LENGTH).fill(""));
        setTimeout(() => inputRefs.current[0]?.focus(), 500);
      }
    } catch {
      setError("Connection error. Try again.");
      setDigits(Array(PIN_LENGTH).fill(""));
    } finally {
      setIsVerifying(false);
    }
  }, []);

  const handleDigitChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;

    const newDigits = [...digits];

    // Handle paste of full PIN
    if (value.length > 1) {
      const pasted = value.slice(0, PIN_LENGTH).split("");
      for (let i = 0; i < PIN_LENGTH; i++) {
        newDigits[i] = pasted[i] || "";
      }
      setDigits(newDigits);
      setError("");

      const filledCount = newDigits.filter((d) => d !== "").length;
      if (filledCount === PIN_LENGTH) {
        handleVerify(newDigits.join(""));
      } else {
        inputRefs.current[filledCount]?.focus();
      }
      return;
    }

    newDigits[index] = value;
    setDigits(newDigits);
    setError("");

    if (value && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all digits are filled
    if (value && index === PIN_LENGTH - 1) {
      const pin = newDigits.join("");
      if (pin.length === PIN_LENGTH) {
        handleVerify(pin);
      }
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      const newDigits = [...digits];
      newDigits[index - 1] = "";
      setDigits(newDigits);
      inputRefs.current[index - 1]?.focus();
    }

    if (e.key === "Enter") {
      const pin = digits.join("");
      if (pin.length === PIN_LENGTH) {
        handleVerify(pin);
      }
    }
  };

  const handleSubmit = () => {
    const pin = digits.join("");
    if (pin.length === PIN_LENGTH) {
      handleVerify(pin);
    }
  };

  // Still checking session — render nothing to avoid flash
  if (isAuthenticated === null) return null;

  // Authenticated — render the admin dashboard
  if (isAuthenticated) return <>{children}</>;

  // PIN gate
  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.lockIcon}>
          <Lock size={24} />
        </div>

        <div className={styles.textGroup}>
          <h2 className={styles.title}>Admin Access</h2>
          <p className={styles.subtitle}>Enter the 4-digit PIN to continue</p>
        </div>

        <div className={styles.pinGroup}>
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              maxLength={PIN_LENGTH}
              value={digit}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              className={`${styles.pinDigit} ${digit ? styles.filled : ""} ${error ? styles.pinDigitError : ""}`}
              disabled={isVerifying}
              autoComplete="off"
            />
          ))}
        </div>

        {error && <span className={styles.errorText}>{error}</span>}

        <button
          className={styles.submitBtn}
          onClick={handleSubmit}
          disabled={digits.join("").length < PIN_LENGTH || isVerifying}
        >
          {isVerifying ? "Verifying…" : "Unlock"}
        </button>
      </div>
    </div>
  );
}
