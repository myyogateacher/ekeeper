import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#09111f",
        mist: "#c3d1e8",
        accent: "#4dd0e1",
        danger: "#f87171",
        warning: "#fbbf24",
        success: "#34d399",
      },
      boxShadow: {
        glass: "0 24px 64px rgba(5, 10, 25, 0.28)",
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
} satisfies Config;
