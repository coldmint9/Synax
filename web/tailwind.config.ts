import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{ts,tsx,vue}'],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        agent: { DEFAULT: "hsl(var(--agent))", foreground: "hsl(var(--agent-foreground))" },
        human: { DEFAULT: "hsl(var(--human))", foreground: "hsl(var(--human-foreground))" },
        success: { DEFAULT: "hsl(var(--success))", foreground: "hsl(var(--success-foreground))" },
        warning: { DEFAULT: "hsl(var(--warning))", foreground: "hsl(var(--warning-foreground))" },
reality: { DEFAULT: "hsl(var(--reality))", foreground: "hsl(var(--reality-foreground))" },
        run: { DEFAULT: "hsl(var(--run))", foreground: "hsl(var(--run-foreground))" },
        neural: { DEFAULT: "hsl(var(--neural-blue))" },
        synaptic: { DEFAULT: "hsl(var(--synaptic-green))" },
        electric: { DEFAULT: "hsl(var(--electric-purple))" },
        "role-pm": { DEFAULT: "hsl(var(--role-pm))" },
        "role-dev": { DEFAULT: "hsl(var(--role-dev))" },
        "role-qa": { DEFAULT: "hsl(var(--role-qa))" },
        "role-prod": { DEFAULT: "hsl(var(--role-prod))" },
        "role-design": { DEFAULT: "hsl(var(--role-design))" },
        "role-devops": { DEFAULT: "hsl(var(--role-devops))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'Monaco', 'Consolas', 'monospace'],
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        "pulse-slow": { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.5" } },
        "slide-in": { from: { transform: "translateX(-10px)", opacity: "0" }, to: { transform: "translateX(0)", opacity: "1" } },
        "ripple-out": {
          "0%": { transform: "scale(0.3)", opacity: "0.8" },
          "100%": { transform: "scale(2.5)", opacity: "0" },
        },
"neuron-fire": {
          "0%": { transform: "scale(1)", opacity: "1" },
          "50%": { transform: "scale(1.3)", opacity: "0.7" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "rumbling-flow": {
          "0%": { strokeDashoffset: "20" },
          "100%": { strokeDashoffset: "0" },
        },
        "fade-up": {
          "0%": { transform: "translateY(8px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "status-ping": {
          "0%": { transform: "scale(1)", opacity: "1" },
          "75%": { transform: "scale(1.8)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "0" },
        },
        "orbital-spin": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "orbit-reverse": {
          "0%": { transform: "rotate(360deg)" },
          "100%": { transform: "rotate(0deg)" },
        },
        "center-breathe": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.8" },
          "50%": { transform: "scale(1.08)", opacity: "1" },
        },
        "particle-flow": {
          "0%": { offsetDistance: "0%", opacity: "0" },
          "10%": { opacity: "1" },
          "90%": { opacity: "1" },
          "100%": { offsetDistance: "100%", opacity: "0" },
        },
        "gradient-shift": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        "shimmer": {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "float-in": {
          "0%": { transform: "translateY(12px) scale(0.96)", opacity: "0" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        "ring-expand": {
          "0%": { transform: "scale(0.8)", opacity: "0.6", strokeWidth: "2px" },
          "100%": { transform: "scale(2.2)", opacity: "0", strokeWidth: "0.5px" },
        },
        "cascade-node-appear": {
          "0%": { transform: "scale(0) translateY(8px)", opacity: "0" },
          "60%": { transform: "scale(1.05) translateY(-2px)", opacity: "1" },
          "100%": { transform: "scale(1) translateY(0)", opacity: "1" },
        },
        "cascade-line-draw": {
          "0%": { strokeDashoffset: "var(--line-length, 200)" },
          "100%": { strokeDashoffset: "0" },
        },
        "cascade-pulse-ring": {
          "0%, 100%": { transform: "scale(1)", opacity: "0.4" },
          "50%": { transform: "scale(1.15)", opacity: "0.8" },
        },
        "thinking-dots": {
          "0%, 20%": { content: "'·'" },
          "40%": { content: "'··'" },
          "60%, 100%": { content: "'···'" },
        },
        "node-shake": {
          "0%, 100%": { transform: "translateX(0)" },
          "25%": { transform: "translateX(-3px)" },
          "75%": { transform: "translateX(3px)" },
        },
        "ripple-wave-bg": {
          "0%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" },
        },
        "minimap-viewport-pulse": {
          "0%, 100%": { borderColor: "hsl(var(--primary) / 0.4)" },
          "50%": { borderColor: "hsl(var(--primary) / 0.7)" },
        },
        "ripple-pulse": {
          "0%": { transform: "scale(1)", opacity: "0.4" },
          "50%": { transform: "scale(1.2)", opacity: "0.1" },
          "100%": { transform: "scale(1.5)", opacity: "0" },
        },
        "origin-breathe": {
          "0%, 100%": { transform: "scale(1)", boxShadow: "0 0 20px hsl(var(--primary) / 0.2)" },
          "50%": { transform: "scale(1.04)", boxShadow: "0 0 40px hsl(var(--primary) / 0.35), 0 0 80px hsl(var(--arch) / 0.14)" },
        },
        "wave-ripple": {
          "0%": { transform: "scale(0.8)", opacity: "0.6", borderWidth: "2px" },
          "100%": { transform: "scale(2.5)", opacity: "0", borderWidth: "0.5px" },
        },
      },
      animation: {
        "pulse-slow": "pulse-slow 3s ease-in-out infinite",
        "slide-in": "slide-in 0.2s ease-out",
        "ripple-out": "ripple-out 1.5s cubic-bezier(0, 0.2, 0.8, 1) forwards",
"neuron-fire": "neuron-fire 0.6s ease-out",
        "rumbling-flow": "rumbling-flow 1s linear infinite",
        "fade-up": "fade-up 0.4s ease-out forwards",
        "status-ping": "status-ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite",
        "orbital-spin": "orbital-spin 20s linear infinite",
        "orbit-reverse": "orbit-reverse 25s linear infinite",
        "center-breathe": "center-breathe 4s ease-in-out infinite",
        "gradient-shift": "gradient-shift 3s ease infinite",
        "shimmer": "shimmer 2s linear infinite",
        "float-in": "float-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "ring-expand": "ring-expand 1.2s cubic-bezier(0, 0, 0.2, 1) forwards",
        "cascade-node-appear": "cascade-node-appear 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "cascade-line-draw": "cascade-line-draw 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "cascade-pulse-ring": "cascade-pulse-ring 3s ease-in-out infinite",
        "node-shake": "node-shake 0.4s ease-out",
        "ripple-wave-bg": "ripple-wave-bg 8s ease infinite",
        "minimap-viewport-pulse": "minimap-viewport-pulse 2s ease-in-out infinite",
        "ripple-pulse": "ripple-pulse 2s cubic-bezier(0, 0, 0.2, 1) infinite",
        "origin-breathe": "origin-breathe 3s ease-in-out infinite",
        "wave-ripple": "wave-ripple 1.5s cubic-bezier(0, 0.2, 0.8, 1) forwards",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
export default config
