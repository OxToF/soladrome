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
          // Primary accent — shifted from neon-green to the atom-logo teal so the
          // whole app inherits the "better DeFi" spectrum. `green` keeps its name
          // (25 components reference it) but now reads teal-cyan.
          green:   "#17e0c4",   // primary accent (teal-cyan)
          teal:    "#12d6c0",
          cyan:    "#2ad4ee",   // spectrum: cyan
          blue:    "#4d8ff5",   // spectrum: blue
          violet:  "#8b6cf6",   // spectrum: violet
          purple:  "#a06bf6",   // spectrum: purple
          dark:    "#070812",   // near-black, blue-violet undertone
          surface: "#0d0f1b",   // card background
          card:    "#0d0f1b",
          elevated:"#14172a",   // elevated surfaces / modals
          border:  "#20243a",   // subtle borders
          muted:   "#5a6188",   // muted / placeholder text
        },
      },
      boxShadow: {
        "glow-sm":  "0 0 12px rgba(42, 212, 238, 0.14)",
        "glow":     "0 0 24px rgba(77, 143, 245, 0.16)",
        "glow-lg":  "0 0 44px rgba(139, 108, 246, 0.22)",
        "card":     "0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)",
        "card-hover":"0 4px 16px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4)",
      },
      backgroundImage: {
        "green-glow": "radial-gradient(ellipse at 50% 0%, rgba(77,143,245,0.10) 0%, rgba(139,108,246,0.05) 42%, transparent 75%)",
        "card-gradient": "linear-gradient(145deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 100%)",
        // Signature spectrum — teal → cyan → blue → violet (matches the atom logo)
        "brand-gradient": "linear-gradient(135deg, #2fe6c0 0%, #29c7e6 34%, #4d8ff5 66%, #9b6cf6 100%)",
      },
      transitionTimingFunction: {
        "smooth": "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    },
  },
  plugins: [],
};
