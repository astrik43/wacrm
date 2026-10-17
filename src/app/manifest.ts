import type { MetadataRoute } from "next";

// Makes the CRM installable ("Add to Home Screen" on iPhone, "Install
// app" on Android/desktop Chrome). Opens straight into the inbox.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chatstrik",
    short_name: "Chatstrik",
    description: "Team inbox, broadcasts and automations for WhatsApp.",
    id: "/",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
