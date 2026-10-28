/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Colors and fonts are the semantic tokens in src/styles/globals.css
      // (@theme), not Tailwind config.
    },
  },
  plugins: [],
}
