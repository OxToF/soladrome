/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        brand: {
          green:   "#00e887",   // signature green — slightly warmer than pure neon
          teal:    "#00c9a7",
          dark:    "#09090f",   // near-black, deep purple undertone
          surface: "#0e1018",   // card background
          card:    "#0e1018",
          elevated:"#141620",   // elevated surfaces / modals
          border:  "#1e2130",   // subtle borders
          muted:   "#4b5270",   // muted / placeholder text
        },
      },
      boxShadow: {
        "glow-sm":  "0 0 12px rgba(0, 232, 135, 0.12)",
        "glow":     "0 0 24px rgba(0, 232, 135, 0.15)",
        "glow-lg":  "0 0 40px rgba(0, 232, 135, 0.20)",
        "card":     "0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)",
        "card-hover":"0 4px 16px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4)",
      },
      backgroundImage: {
        "green-glow": "radial-gradient(ellipse at 50% 0%, rgba(0,232,135,0.06) 0%, transparent 70%)",
        "card-gradient": "linear-gradient(145deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 100%)",
      },
      transitionTimingFunction: {
        "smooth": "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    },
  },
  plugins: [],
};
