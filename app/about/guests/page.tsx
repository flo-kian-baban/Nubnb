"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  Shield,
  MapPin,
  Zap,
  Star,
  ChevronDown,
  Search,
  Calendar,
  CheckCircle,
} from "lucide-react";
import { getProperties } from "@/app/lib/firebase/properties";
import type { Property } from "@/app/types/property";
import styles from "./page.module.css";

const PreviewMap = dynamic(
  () => import("@/app/components/PreviewMap").then((m) => m.PreviewMap),
  { ssr: false }
);

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
  { value: 8, suffix: "+", prefix: "", label: "Curated Properties" },
  { value: 6, suffix: "", prefix: "", label: "GTA Cities" },
  { value: 4.9, suffix: "", prefix: "", label: "Avg Guest Rating" },
];

const features = [
  {
    icon: Shield,
    title: "Verified Properties Only",
    desc: "Every listing is inspected and photographed by our team before it goes live. No catfishing, no surprises.",
    img: "/images/features/verified.png",
    alt: "NUBNB team inspecting a verified rental property in Toronto",
  },
  {
    icon: MapPin,
    title: "GTA-Native, Not Global",
    desc: "We don't spread thin. Deep local knowledge means better picks for Toronto, Markham, Vaughan, and beyond.",
    img: "/images/features/gta.png",
    alt: "Aerial view of Greater Toronto Area neighborhoods served by NUBNB",
  },
  {
    icon: Zap,
    title: "Responsive Hosts, Fast Support",
    desc: "Professionally managed properties with guaranteed response times. No ghosting.",
    img: "/images/features/support.png",
    alt: "NUBNB host providing responsive guest support via mobile",
  },
  {
    icon: Star,
    title: "Transparent Pricing",
    desc: "What you see is what you pay. No surprise cleaning fees or hidden weekend surcharges.",
    img: "/images/features/pricing.png",
    alt: "Transparent pricing display showing no hidden fees on NUBNB listing",
  },
];

const steps = [
  {
    num: "01",
    icon: Search,
    title: "Browse & Filter",
    desc: "Explore our curated catalogue. Filter by neighborhood, price, guest capacity, or amenities.",
  },
  {
    num: "02",
    icon: Calendar,
    title: "Book Instantly",
    desc: "Pick your dates and reserve directly. Real-time availability, no back-and-forth messaging.",
  },
  {
    num: "03",
    icon: CheckCircle,
    title: "Check In & Enjoy",
    desc: "Get a digital guidebook, smart-lock codes, and 24/7 support. Your stay is fully handled.",
  },
];



/* ═════════════════════════════════════════════
   COMPONENT
   ═════════════════════════════════════════════ */
export default function GuestsPage() {
  /* CountUp refs */
  const s0 = useRef<HTMLSpanElement>(null);
  const s1 = useRef<HTMLSpanElement>(null);
  const s2 = useRef<HTMLSpanElement>(null);
  const statRefs = [s0, s1, s2];

  useCountUp(s0, stats[0].value, stats[0].suffix);
  useCountUp(s1, stats[1].value);
  useCountUp(s2, stats[2].value);

  /* Fetch live properties */
  const [properties, setProperties] = useState<Property[]>([]);

  useEffect(() => {
    getProperties().then(setProperties);
  }, []);

  /* Derive city counts from real data */
  const cityCounts = useMemo(() => {
    const map: Record<string, number> = {};
    properties.forEach((p) => {
      const city = p.addressDetails?.city || "Other";
      map[city] = (map[city] || 0) + 1;
    });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [properties]);

  /* JSON-LD Structured Data */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "For Guests | NUBNB Suites",
    description: "Browse curated short-term rental properties across the Greater Toronto Area. Verified listings, transparent pricing, and responsive local hosts.",
    url: "https://nubnb.ca/about/guests",
    publisher: {
      "@type": "Organization",
      name: "NUBNB Suites",
      url: "https://nubnb.ca",
      logo: {
        "@type": "ImageObject",
        url: "https://nubnb.ca/logo-nubnb.png",
      },
      areaServed: {
        "@type": "Place",
        name: "Greater Toronto Area, Ontario, Canada",
      },
    },
  };

  return (
    <motion.div
      className={styles.page}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* ── NAV ───────────────────────────── */}
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
          <Link href="/" className={styles.navCta}>
            Browse Stays
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
          Short-Term Rentals · Greater Toronto Area
        </motion.p>

        <motion.h1
          className={styles.heroTitle}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          Premium stays,
          <br />
          <span className={styles.heroTitleAccent}>locally managed.</span>
        </motion.h1>

        <motion.p
          className={styles.heroSub}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          Curated short-term rentals; condos, townhomes, and estates, managed
          by people who actually live here. No corporate middlemen.
        </motion.p>

        <motion.div
          className={styles.heroActions}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          <Link href="/" className={styles.btnPrimary}>
            Browse All Stays
            <ArrowRight size={16} className={styles.btnArrow} />
          </Link>
          <a href="#how-it-works" className={styles.btnSecondary}>
            How It Works
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
          Why NuBnb
        </motion.p>
        <motion.h2
          className={`${styles.sectionTitle} ${styles.centered}`}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={1}
        >
          A better way to book a stay.
        </motion.h2>
        <motion.p
          className={`${styles.sectionSub} ${styles.centered}`}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={2}
        >
          We built NuBnb because the big platforms lost the personal touch. Every
          property in our catalogue is locally managed, fully verified, and
          priced transparently.
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
                    alt={f.alt}
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
          Three steps to your perfect stay.
        </motion.h2>
        <motion.p
          className={styles.sectionSub}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={2}
        >
          No accounts required. No lengthy sign-ups. Just browse, book, and go.
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

      {/* ── WHERE WE OPERATE ───────────────── */}
      <section className={styles.operateSection}>
        <div className={styles.operateContent}>
          <motion.p
            className={styles.sectionEyebrow}
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            custom={0}
          >
            Where We Operate
          </motion.p>
          <motion.h2
            className={styles.sectionTitle}
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            custom={1}
          >
            The GTA, covered.
          </motion.h2>
          <motion.p
            className={styles.operateDesc}
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            custom={2}
          >
            From the downtown core to suburban gems, we have properties across
            the Greater Toronto Area. Every listing is locally managed, fully
            verified, and ready for your next stay.
          </motion.p>

          <motion.div
            className={styles.cityList}
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            {cityCounts.map((c) => (
              <motion.div className={styles.cityRow} key={c.name} variants={cardFade}>
                <span className={styles.cityName}>{c.name}</span>
                <span className={styles.cityCount}>
                  {c.count} {c.count === 1 ? "property" : "properties"}
                </span>
              </motion.div>
            ))}
          </motion.div>

          <Link href="/" className={styles.operateLink}>
            Browse all properties <ArrowRight size={16} />
          </Link>
        </div>

        <motion.div
          className={styles.operateMap}
          initial={{ opacity: 0, scale: 0.96 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <PreviewMap properties={properties} />
          <div className={styles.mapOverlay}>
            <Link href="/" className={styles.mapCta}>
              <MapPin size={16} />
              View interactive map
            </Link>
          </div>
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
          Ready to find your next stay?
        </motion.h2>
        <motion.p
          className={styles.ctaBandSub}
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          custom={1}
        >
          Browse our full catalogue; real photos, real prices, real availability.
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
            Browse All Stays
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
          <Link href="/about/partners" className={styles.footerLink}>
            For Partners
          </Link>
          <Link href="/" className={styles.footerLink}>
            Browse
          </Link>
        </div>
      </footer>
    </motion.div>
  );
}
