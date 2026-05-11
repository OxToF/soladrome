/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          green: "#00ff87",
          teal:  "#00c9a7",
          dark:  "#0a0e1a",
          card:  "#111827",
          border:"#1f2937",
        },
      },
    },
  },
  plugins: [],
};
