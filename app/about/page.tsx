"use client";

import { useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { usePageTransition } from "./AboutLayoutClient";
import styles from "./page.module.css";


/* ─── Entrance variants ──────────────────── */
const panelLeft = {
  hidden: { x: "-40px", opacity: 0 },
  visible: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.6, ease: [0.25, 1, 0.5, 1] as const },
  },
};

const panelRight = {
  hidden: { x: "40px", opacity: 0 },
  visible: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.6, ease: [0.25, 1, 0.5, 1] as const },
  },
};

const fadeUp = {
  hidden: { y: 14, opacity: 0 },
  visible: (i: number) => ({
    y: 0,
    opacity: 1,
    transition: { duration: 0.45, ease: [0.25, 1, 0.5, 1] as const, delay: i * 0.08 },
  }),
};

/* ═════════════════════════════════════════════
   ABOUT ROUTER
   ═════════════════════════════════════════════ */
export default function AboutPage() {
  const transition = usePageTransition();
  const [chosen, setChosen] = useState<"guests" | "partners" | null>(null);

  const handleClick = (side: "guests" | "partners") => {
    if (chosen) return;
    setChosen(side);

    // Trigger the layout overlay + navigation (synced with the CSS expansion)
    transition(
      `/about/${side}`,
      side === "guests" ? "#1A1A1D" : "#FFFFFF"
    );
  };

  return (
    <main className={styles.page}>
      {/* Visually hidden h1 for SEO heading hierarchy */}
      <h1 style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}>
        NUBNB Suites | Premium Short-Term Rentals in the Greater Toronto Area
      </h1>

      {/* ── TOP NAV ──────────────────── */}
      <nav className={styles.topNav}>
        <Link href="/" className={styles.navLogo}>
          <Image
            src="/logo-nubnb.png"
            alt="NuBnb Suites"
            width={28}
            height={28}
            priority
            className={styles.navLogoImg}
          />
          <span className={styles.navWordmark}>NUBNB</span>
        </Link>
        <div className={styles.navLinks}>
          <Link href="/about/guests" className={styles.navLink}>
            For Guests
          </Link>
          <Link href="/about/partners" className={styles.navLink}>
            For Partners
          </Link>
          <Link href="/contact" className={styles.navLink}>
            Contact
          </Link>
          <Link href="/fund" className={styles.navCta}>
            The Fund
          </Link>
        </div>
      </nav>

      {/* LEFT — Guests */}
      <motion.div
        className={`${styles.panel} ${styles.panelDark}${
          chosen === "guests" ? ` ${styles.expand}` : ""
        }${chosen === "partners" ? ` ${styles.collapse}` : ""}`}
        variants={panelLeft}
        initial="hidden"
        animate="visible"
        onClick={() => handleClick("guests")}
      >
        <div className={`${styles.panelInner}${chosen ? ` ${styles.fadeOut}` : ""}`}>
          <motion.p className={styles.eyebrow} variants={fadeUp} initial="hidden" animate="visible" custom={0}>
            I&rsquo;m looking for a stay
          </motion.p>
          <motion.h2 className={styles.headline} variants={fadeUp} initial="hidden" animate="visible" custom={1}>
            Find Your<br />Next Stay
          </motion.h2>
          <motion.p className={`${styles.subline} ${styles.sublineDark}`} variants={fadeUp} initial="hidden" animate="visible" custom={2}>
            Browse curated short-term rentals across the Greater Toronto Area.
          </motion.p>
          <motion.div className={styles.miniStats} variants={fadeUp} initial="hidden" animate="visible" custom={3}>
            <div className={styles.miniStat}>
              <span className={styles.miniStatNum}>40+</span>
              <span className={styles.miniStatLabel}>Properties</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatNum}>8</span>
              <span className={styles.miniStatLabel}>GTA Cities</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatNum}>4.9★</span>
              <span className={styles.miniStatLabel}>Avg Rating</span>
            </div>
          </motion.div>
          <motion.span className={`${styles.cta} ${styles.ctaDark}`} variants={fadeUp} initial="hidden" animate="visible" custom={4}>
            Explore
            <ArrowRight size={16} className={styles.ctaArrow} />
          </motion.span>
        </div>
      </motion.div>

      {/* RIGHT — Partners */}
      <motion.div
        className={`${styles.panel} ${styles.panelLight}${
          chosen === "partners" ? ` ${styles.expand}` : ""
        }${chosen === "guests" ? ` ${styles.collapse}` : ""}`}
        variants={panelRight}
        initial="hidden"
        animate="visible"
        onClick={() => handleClick("partners")}
      >
        <div className={`${styles.panelInner}${chosen ? ` ${styles.fadeOut}` : ""}`}>
          <motion.p className={styles.eyebrow} variants={fadeUp} initial="hidden" animate="visible" custom={0}>
            I own a property
          </motion.p>
          <motion.h2 className={styles.headline} variants={fadeUp} initial="hidden" animate="visible" custom={1}>
            Grow Your<br />Rental Income
          </motion.h2>
          <motion.p className={`${styles.subline} ${styles.sublineLight}`} variants={fadeUp} initial="hidden" animate="visible" custom={2}>
            Partner with NuBnb Suites for hands-free property management in the GTA.
          </motion.p>
          <motion.div className={`${styles.miniStats} ${styles.miniStatsLight}`} variants={fadeUp} initial="hidden" animate="visible" custom={3}>
            <div className={styles.miniStat}>
              <span className={styles.miniStatNum}>$600</span>
              <span className={styles.miniStatLabel}>Avg Nightly</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatNum}>85%</span>
              <span className={styles.miniStatLabel}>Occupancy</span>
            </div>
            <div className={styles.miniStat}>
              <span className={styles.miniStatNum}>6</span>
              <span className={styles.miniStatLabel}>Cities</span>
            </div>
          </motion.div>
          <motion.span className={`${styles.cta} ${styles.ctaLight}`} variants={fadeUp} initial="hidden" animate="visible" custom={4}>
            Learn More
            <ArrowRight size={16} className={styles.ctaArrow} />
          </motion.span>
        </div>
      </motion.div>

    </main>
  );
}
