"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  TrendingUp,
  Home,
  Users,
  CheckCircle,
  ChevronDown,
  Shield,
  BarChart3,
  Sparkles,
  Wrench,
  Phone,
  Camera,
  Calendar,
  DollarSign,
} from "lucide-react";
import styles from "./page.module.css";

/* ─── CountUp hook ───────────────────────── */
function useCountUp(
  ref: React.RefObject<HTMLSpanElement | null>,
  target: number,
  suffix = "",
  prefix = "",
  duration = 1400
) {
  const hasAnimated = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true;
          const start = performance.now();

          const step = (now: number) => {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(eased * target);
            el.textContent = `${prefix}${current.toLocaleString()}${suffix}`;
            if (progress < 1) requestAnimationFrame(step);
          };

          requestAnimationFrame(step);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, target, suffix, prefix, duration]);
}

/* ─── Animation variants ─────────────────── */
const fadeUp = {
  hidden: { y: 20, opacity: 0 },
  visible: (i: number) => ({
    y: 0,
    opacity: 1,
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] as const, delay: i * 0.08 },
  }),
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};

const cardFade = {
  hidden: { y: 24, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] as const },
  },
};

/* ─── Data ───────────────────────────────── */
const stats = [
  { value: 70, suffix: "+", prefix: "$", label: "Avg Nightly Rate" },
  { value: 85, suffix: "%", prefix: "", label: "Occupancy Rate" },
  { value: 6, suffix: "", prefix: "", label: "GTA Cities" },
  { value: 24, suffix: "/7", prefix: "", label: "Support Coverage" },
];

const features = [
  {
    icon: TrendingUp,
    title: "Maximise Your Income",
    desc: "Our dynamic pricing engine and distribution strategy consistently outperform self-managed listings by 20-35%.",
    img: "/images/partners/income.png",
  },
  {
    icon: Home,
    title: "Full-Service Management",
    desc: "From guest screening to cleaning coordination, we handle every aspect of operations so you don't have to.",
    img: "/images/partners/management.png",
  },
  {
    icon: Users,
    title: "Vetted Guests, Every Time",
    desc: "ID verification, damage deposits, and house rules enforced before every check-in. Your property stays protected.",
    img: "/images/partners/security.png",
  },
  {
    icon: CheckCircle,
    title: "Local Expertise You Can Trust",
    desc: "We operate exclusively in the GTA. Your property is managed by neighbours, not faceless algorithms.",
    img: "/images/partners/local.png",
  },
];

const steps = [
  {
    num: "01",
    icon: Calendar,
    title: "Schedule a Consultation",
    desc: "We'll visit your property, assess its potential, and provide a free earnings estimate based on real market data.",
  },
  {
    num: "02",
    icon: Camera,
    title: "We Handle the Setup",
    desc: "Professional photography, listing optimization, pricing strategy, and smart-lock installation, all on us.",
  },
  {
    num: "03",
    icon: DollarSign,
    title: "Sit Back & Earn",
    desc: "We manage guests, cleaning, maintenance, and accounting. You receive monthly payouts with full transparency.",
  },
];

const services = [
  { icon: Camera, name: "Professional Photography", desc: "HDR photos, drone footage, virtual tours" },
  { icon: BarChart3, name: "Dynamic Pricing", desc: "AI-driven nightly rate optimization" },
  { icon: Shield, name: "Guest Screening", desc: "ID verification & damage deposits" },
  { icon: Sparkles, name: "Turnover Cleaning", desc: "Hotel-grade between every guest" },
  { icon: Wrench, name: "Maintenance", desc: "24/7 emergency response & upkeep" },
  { icon: Phone, name: "Guest Communication", desc: "Check-in to check-out, fully handled" },
];

/* ═════════════════════════════════════════════
   COMPONENT
   ═════════════════════════════════════════════ */
export default function PartnersPage() {
  /* CountUp refs */
  const s0 = useRef<HTMLSpanElement>(null);
  const s1 = useRef<HTMLSpanElement>(null);
  const s2 = useRef<HTMLSpanElement>(null);
  const s3 = useRef<HTMLSpanElement>(null);
  const statRefs = [s0, s1, s2, s3];

  useCountUp(s0, stats[0].value, stats[0].suffix, stats[0].prefix);
  useCountUp(s1, stats[1].value, stats[1].suffix);
  useCountUp(s2, stats[2].value);
  useCountUp(s3, stats[3].value, stats[3].suffix);

  useEffect(() => {
    document.title = "For Partners | NUBNB Suites";
  }, []);

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* ── NAV ───────────────────────────── */}
      <nav className={styles.nav}>
        <Link href="/about" className={styles.navLogo}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <ArrowLeft size={14} />
            NUBNB
          </span>
        </Link>
        <div className={styles.navLinks}>
          <Link href="/about/guests" className={styles.navLink}>
            For Guests
          </Link>
          <Link href="/" className={styles.navCta}>
            View Properties
          </Link>
        </div>
      </nav>

      {/* ── HERO ──────────────────────────── */}
      <section className={styles.hero}>
        <div className={styles.heroBg} />
        <motion.p
          className={styles.heroEyebrow}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={0}
        >
          Property Management · Greater Toronto Area
        </motion.p>

        <motion.h1
          className={styles.heroTitle}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          Your property,
          <br />
          <span className={styles.heroTitleAccent}>our expertise.</span>
        </motion.h1>

        <motion.p
          className={styles.heroSub}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          Partner with NuBnb Suites and turn your GTA property into a
          professionally managed, income-generating asset, without lifting a finger.
        </motion.p>

        <motion.div
          className={styles.heroActions}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          <a href="#how-it-works" className={styles.btnPrimary}>
            Get Started
            <ArrowRight size={16} className={styles.btnArrow} />
          </a>
          <a href="#services" className={styles.btnSecondary}>
            Our Services
            <ArrowRight size={16} className={styles.btnArrow} />
          </a>
        </motion.div>

        {/* Stats bar inside hero */}
        <motion.div
          className={styles.statsBar}
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          {stats.map((stat, i) => (
            <motion.div className={styles.statItem} key={stat.label} variants={cardFade}>
              <span className={styles.statNumber} ref={statRefs[i]}>
                0
              </span>
              <span className={styles.statLabel}>{stat.label}</span>
            </motion.div>
          ))}
        </motion.div>

        <div className={styles.heroScroll}>
          <span>Scroll</span>
          <ChevronDown size={16} />
        </div>
      </section>

      <div className={styles.divider} />

      {/* ── FEATURES ─────────────────────── */}
      <section className={styles.section}>
        <motion.p
          className={`${styles.sectionEyebrow} ${styles.centered}`}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={0}
        >
          Why Partner With Us
        </motion.p>
        <motion.h2
          className={`${styles.sectionTitle} ${styles.centered}`}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={1}
        >
          Built for homeowners who want results.
        </motion.h2>
        <motion.p
          className={`${styles.sectionSub} ${styles.centered}`}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={2}
        >
          We don&rsquo;t just list your property; we optimize, manage, and grow your
          rental income with a hands-on, local approach.
        </motion.p>

        <motion.div
          className={styles.bentoGrid}
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.1 }}
        >
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <motion.div
                className={`${styles.bentoCard} ${styles[`bento${i + 1}`]}`}
                key={f.title}
                variants={cardFade}
              >
                <div className={styles.bentoImg}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.img}
                    alt=""
                    className={styles.bentoPhoto}
                    loading="lazy"
                  />
                  <div className={styles.bentoImgOverlay} />
                </div>
                <div className={styles.bentoContent}>
                  <div className={styles.bentoIcon}>
                    <Icon size={20} strokeWidth={1.8} />
                  </div>
                  <h3 className={styles.bentoTitle}>{f.title}</h3>
                  <p className={styles.bentoDesc}>{f.desc}</p>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </section>

      <div className={styles.divider} />

      {/* ── HOW IT WORKS ─────────────────── */}
      <section className={styles.howSection} id="how-it-works">
        <motion.p
          className={styles.sectionEyebrow}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={0}
        >
          How It Works
        </motion.p>
        <motion.h2
          className={styles.sectionTitle}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={1}
        >
          From signup to income in three steps.
        </motion.h2>
        <motion.p
          className={styles.sectionSub}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={2}
        >
          We handle everything; you just own the property and collect the returns.
        </motion.p>

        <motion.div
          className={styles.timeline}
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.15 }}
        >
          {steps.map((s, i) => (
            <motion.div className={styles.timelineStep} key={s.num} variants={cardFade}>
              <div className={styles.timelineIconWrap}>
                <div className={styles.timelineIcon}>
                  <s.icon size={24} strokeWidth={1.6} />
                </div>
                {i < steps.length - 1 && <div className={styles.timelineConnector} />}
              </div>
              <div className={styles.timelineContent}>
                <span className={styles.timelineNum}>{s.num}</span>
                <h3 className={styles.timelineTitle}>{s.title}</h3>
                <p className={styles.timelineDesc}>{s.desc}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <div className={styles.divider} />

      {/* ── SERVICES ─────────────────────── */}
      <section className={styles.section} id="services">
        <motion.p
          className={styles.sectionEyebrow}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={0}
        >
          What&rsquo;s Included
        </motion.p>
        <motion.h2
          className={styles.sectionTitle}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={1}
        >
          End-to-end property management.
        </motion.h2>
        <motion.p
          className={styles.sectionSub}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={2}
        >
          Every NuBnb partnership includes the full suite; no add-ons, no tiers.
        </motion.p>

        <motion.div
          className={styles.servicesGrid}
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.1 }}
        >
          {services.map((svc) => (
            <motion.div className={styles.serviceCard} key={svc.name} variants={cardFade}>
              <div className={styles.serviceIcon}>
                <svc.icon size={20} strokeWidth={1.8} />
              </div>
              <div className={styles.serviceName}>{svc.name}</div>
              <div className={styles.serviceDesc}>{svc.desc}</div>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <div className={styles.divider} />

      {/* ── FINAL CTA ────────────────────── */}
      <section className={styles.ctaBand}>
        <div className={styles.ctaBandBg} />
        <motion.h2
          className={styles.ctaBandTitle}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={0}
        >
          Ready to unlock your property&rsquo;s potential?
        </motion.h2>
        <motion.p
          className={styles.ctaBandSub}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={1}
        >
          Get a free earnings estimate; no commitment, no pressure.
        </motion.p>
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={2}
          style={{ position: "relative", zIndex: 1 }}
        >
          <Link href="/" className={styles.btnPrimary}>
            Schedule a Consultation
            <ArrowRight size={16} className={styles.btnArrow} />
          </Link>
        </motion.div>
      </section>

      {/* ── FOOTER ───────────────────────── */}
      <footer className={styles.footer}>
        <span className={styles.footerLeft}>
          © {new Date().getFullYear()} NuBnb Suites. All rights reserved.
        </span>
        <div className={styles.footerLinks}>
          <Link href="/about" className={styles.footerLink}>
            About
          </Link>
          <Link href="/about/guests" className={styles.footerLink}>
            For Guests
          </Link>
          <Link href="/" className={styles.footerLink}>
            Browse
          </Link>
        </div>
      </footer>
    </motion.div>
  );
}
