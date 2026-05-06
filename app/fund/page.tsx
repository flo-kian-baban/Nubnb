"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Send, TrendingUp, Shield } from "lucide-react";
import styles from "./page.module.css";

/* ─── Investment Calculator ──────────────── */
function InvestmentCalc({
  rate,
  min,
  max,
  step,
  label,
}: {
  rate: number;
  min: number;
  max: number;
  step: number;
  label: string;
}) {
  const [amount, setAmount] = useState(min);

  const annual = amount * rate;
  const monthly = annual / 12;

  const pct = ((amount - min) / (max - min)) * 100;

  return (
    <div className={styles.calc}>
      <div className={styles.calcHeader}>
        <span className={styles.calcIcon}>
          <TrendingUp size={14} />
        </span>
        <span className={styles.calcTitle}>Return Calculator</span>
      </div>

      <div className={styles.calcBody}>
        <div className={styles.calcSliderRow}>
          <label className={styles.calcLabel}>Investment Amount</label>
          <span className={styles.calcAmount}>
            ${amount.toLocaleString("en-US")}
          </span>
        </div>

        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className={styles.calcSlider}
          style={
            {
              "--slider-pct": `${pct}%`,
            } as React.CSSProperties
          }
        />

        <div className={styles.calcRange}>
          <span>${min.toLocaleString("en-US")}</span>
          <span>${max.toLocaleString("en-US")}</span>
        </div>
      </div>

      <div className={styles.calcResults}>
        <div className={styles.calcResult}>
          <span className={styles.calcResultLabel}>Monthly Income</span>
          <span className={styles.calcResultValue}>
            ${monthly.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div className={styles.calcResultDivider} />
        <div className={styles.calcResult}>
          <span className={styles.calcResultLabel}>Annual Return</span>
          <span className={`${styles.calcResultValue} ${styles.calcResultAccent}`}>
            ${annual.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        </div>
      </div>

      <p className={styles.calcDisclaimer}>
        {label}
      </p>
    </div>
  );
}

/* ─── Animation variants (matches partners page) ─── */
const fadeUp = {
  hidden: { y: 24, opacity: 0 },
  visible: (i: number) => ({
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.6,
      ease: [0.25, 1, 0.5, 1] as const,
      delay: 0.1 + i * 0.1,
    },
  }),
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

const cardStagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.15 } },
};

const cardFade = {
  hidden: { y: 30, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] as const },
  },
};

const sectionFade = {
  hidden: { y: 30, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] as const },
  },
};

/* ─── Data ────────────────────────────────── */
const trustStats = [
  { num: "$2M+", label: "Capital Deployed" },
  { num: "70+", label: "Properties in Portfolio" },
  { num: "100%", label: "Payment Track Record" },
];

const guaranteedFeatures = [
  "Monthly cash distributions",
  "Capital secured against real assets",
  "Fixed 12% annual yield",
  "Flexible exit terms after 12 months",
];

const profitFeatures = [
  "Profit share on portfolio revenue",
  "Estimated 30% annual return",
  "Quarterly performance reporting",
  "Priority access to new properties",
];

const steps = [
  {
    num: "01",
    icon: <Send size={24} />,
    title: "Reach Out",
    desc: "Contact our investment team via the form. We respond within 24 hours.",
  },
  {
    num: "02",
    icon: <Shield size={24} />,
    title: "Review the Terms",
    desc: "We walk you through the full agreement, returns structure, and timeline.",
  },
  {
    num: "03",
    icon: <TrendingUp size={24} />,
    title: "Start Earning",
    desc: "Your capital is deployed. Returns begin the following month.",
  },
];

/* ═════════════════════════════════════════════
   THE FUND
   ═════════════════════════════════════════════ */
export default function FundPage() {
  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* ── NAV (matches partners nav exactly) ──── */}
      <nav className={styles.nav}>
        <Link href="/about" className={styles.navLogo}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <ArrowLeft size={14} />
            NUBNB
          </span>
        </Link>
        <div className={styles.navLinks}>
          <Link href="/about/partners" className={styles.navLink}>
            For Partners
          </Link>
          <Link href="/contact" className={styles.navLink}>
            Contact
          </Link>
          <Link href="/" className={styles.navCta}>
            View Properties
          </Link>
        </div>
      </nav>

      {/* ═══ SECTION 1 — HERO ═══════════════════ */}
      <section className={styles.hero}>
        <div className={styles.heroBg} />

        <motion.p
          className={styles.eyebrow}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={0}
        >
          NuBnb Suites · Exclusive Investment Program
        </motion.p>

        <motion.h1
          className={styles.heroHeadline}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          Your money,
          <br />
          <span className={styles.heroAccent}>working in real&nbsp;estate.</span>
        </motion.h1>

        <motion.p
          className={styles.heroSub}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          The Fund is NuBnb&rsquo;s private investment program, built for
          individuals who want real estate returns without the complexity of
          ownership.
        </motion.p>

        <motion.div
          className={styles.heroCtas}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          <a href="#opportunities" className={styles.btnPrimary}>
            View Opportunities
            <ArrowRight size={16} className={styles.btnArrow} />
          </a>
          <Link href="/contact" className={styles.btnSecondary}>
            Talk to Us
            <ArrowRight size={16} className={styles.btnArrow} />
          </Link>
        </motion.div>

        {/* Stats bar inside hero */}
        <motion.div
          className={styles.statsBar}
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {trustStats.map((stat) => (
            <motion.div className={styles.statItem} key={stat.label} variants={cardFade}>
              <span className={styles.statNumber}>{stat.num}</span>
              <span className={styles.statLabel}>{stat.label}</span>
            </motion.div>
          ))}
        </motion.div>

        <div className={styles.heroScroll}>
          <ChevronDown size={16} />
        </div>
      </section>

      <div className={styles.divider} />

      {/* ═══ SECTION 3 — OPPORTUNITIES ═══════════ */}
      <motion.section
        className={styles.section}
        id="opportunities"
        variants={sectionFade}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
      >
        <p className={styles.sectionEyebrow}>Investment Options</p>
        <h2 className={styles.sectionTitle}>Two Ways to Invest</h2>
        <p className={styles.sectionSub}>
          Choose the structure that matches your goals, whether guaranteed fixed
          income or growth-tied profit sharing.
        </p>

        <motion.div
          className={styles.cardGrid}
          variants={cardStagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.2 }}
        >
          {/* CARD 1 — Guaranteed */}
          <motion.div className={styles.card} variants={cardFade}>
            <span className={`${styles.badge} ${styles.badgeBlue}`}>
              Fixed Income
            </span>
            <h3 className={styles.cardHeadline}>12% Annual Return</h3>
            <p className={styles.cardSub}>Guaranteed. Paid monthly.</p>
            <p className={styles.cardMin}>Minimum investment: $50,000</p>
            <p className={styles.cardDesc}>
              Receive a fixed 12% annual return on your capital, distributed as
              monthly payments directly to your account. Your principal is
              secured against NuBnb&rsquo;s managed property portfolio. No
              market exposure. No surprises.
            </p>
            <ul className={styles.cardFeatures}>
              {guaranteedFeatures.map((f) => (
                <li className={styles.cardFeature} key={f}>
                  <span className={styles.featureCheck}>
                    <Check size={12} strokeWidth={2.5} />
                  </span>
                  {f}
                </li>
              ))}
            </ul>
            <div className={styles.cardCta}>
              <Link href="/contact" className={styles.btnPrimary}>
                Invest at 12%
                <ArrowRight size={16} className={styles.btnArrow} />
              </Link>
            </div>
            <InvestmentCalc
              rate={0.12}
              min={50000}
              max={500000}
              step={10000}
              label="Based on fixed 12% annual return, as outlined in your signed agreement."
            />
          </motion.div>

          {/* CARD 2 — Profit Share */}
          <motion.div
            className={`${styles.card} ${styles.cardElevated}`}
            variants={cardFade}
          >
            <span className={`${styles.badge} ${styles.badgeDark}`}>
              Growth Partner
            </span>
            <h3 className={styles.cardHeadline}>
              Up to 30% Estimated Return
            </h3>
            <p className={styles.cardSub}>
              Profit share. Own a piece of the portfolio.
            </p>
            <p className={styles.cardMin}>Minimum investment: $100,000</p>
            <p className={styles.cardDesc}>
              Become a capital partner in NuBnb&rsquo;s managed rental
              portfolio. Your returns are tied directly to property performance,
              with estimated annual returns of up to 30% based on
              current occupancy rates and nightly revenue.
            </p>
            <ul className={styles.cardFeatures}>
              {profitFeatures.map((f) => (
                <li className={styles.cardFeature} key={f}>
                  <span className={styles.featureCheck}>
                    <Check size={12} strokeWidth={2.5} />
                  </span>
                  {f}
                </li>
              ))}
            </ul>
            <div className={styles.cardCta}>
              <Link href="/contact" className={styles.btnPrimary}>
                Become a Partner
                <ArrowRight size={16} className={styles.btnArrow} />
              </Link>
            </div>
            <InvestmentCalc
              rate={0.30}
              min={100000}
              max={1000000}
              step={25000}
              label="Estimated based on current portfolio performance. Actual returns may vary."
            />
          </motion.div>
        </motion.div>
      </motion.section>

      <div className={styles.divider} />

      {/* ═══ SECTION 4 — HOW IT WORKS ════════════ */}
      <motion.div
        className={styles.howSection}
        variants={sectionFade}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
      >
        <p className={styles.sectionEyebrow}>Process</p>
        <h2 className={styles.sectionTitle}>Simple by Design</h2>
        <p className={styles.sectionSub}>
          From first conversation to first payout, in three
          straightforward steps.
        </p>

        <div className={styles.timeline}>
          {steps.map((step, i) => (
            <div className={styles.timelineStep} key={step.num}>
              <div className={styles.timelineIconWrap}>
                {i < steps.length - 1 && (
                  <div className={styles.timelineConnector} />
                )}
                <div className={styles.timelineIcon}>{step.icon}</div>
              </div>
              <div className={styles.timelineContent}>
                <span className={styles.timelineNum}>{step.num}</span>
                <h3 className={styles.timelineTitle}>{step.title}</h3>
                <p className={styles.timelineDesc}>{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ═══ SECTION 5 — LEGAL ═══════════════════ */}
      <section className={styles.legal}>
        <p className={styles.legalText}>
          The Fund is a private investment program operated by NuBnb Suites Inc.
          All investment opportunities are subject to individual agreements.
          Estimated returns are projections based on current portfolio
          performance and are not guaranteed unless explicitly stated in a signed
          agreement. Past performance does not guarantee future results. This
          page does not constitute a public offering. For information, contact us
          directly.
        </p>
      </section>

      {/* ═══ SECTION 6 — FINAL CTA ═══════════════ */}
      <motion.section
        className={styles.ctaBand}
        variants={sectionFade}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
      >
        <h2 className={styles.ctaBandTitle}>
          Ready to Put Your Capital to&nbsp;Work?
        </h2>
        <p className={styles.ctaBandSub}>
          Speak with the NuBnb investment team. No obligation.
        </p>
        <Link href="/contact" className={styles.btnWhite}>
          Get in Touch
          <ArrowRight size={16} className={styles.btnArrow} />
        </Link>
      </motion.section>

      {/* ── FOOTER ──────────────────────────── */}
      <footer className={styles.footer}>
        <span className={styles.footerLeft}>
          © {new Date().getFullYear()} NuBnb Suites Inc.
        </span>
        <div className={styles.footerLinks}>
          <Link href="/about" className={styles.footerLink}>About</Link>
          <Link href="/contact" className={styles.footerLink}>Contact</Link>
          <Link href="/" className={styles.footerLink}>Properties</Link>
        </div>
      </footer>
    </motion.div>
  );
}
