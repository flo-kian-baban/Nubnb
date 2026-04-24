import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/about", "/about/guests", "/about/partners"],
        disallow: ["/admin", "/api/"],
      },
    ],
    sitemap: "https://nubnb.ca/sitemap.xml",
  };
}
