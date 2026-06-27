# AzTracker Global Design & Project Instructions

This file serves as the overarching design language and technological rulebook for all AzTracker repositories (both the Server and the frontend). It must be adhered to at all times to ensure visual excellence and consistency.

## 1. Technology Stack
- **Core:** Use HTML for structure and JavaScript for logic.
- **Styling (CSS):** Use Vanilla CSS for maximum flexibility and control. Avoid using TailwindCSS for the user dashboard. (Note: The CRM dashboard currently uses Tailwind, which is permitted, but do not replicate it to user-facing dashboards).
- **Frameworks:** For new, complex web apps, frameworks like Next.js or Vite may be used. Initialize them via `npx` in non-interactive mode.
- **Local Dev:** Run using `npm run dev` or equivalent. Only build the production bundle when explicitly requested or validating code correctness.

## 2. Design Aesthetics (The "Command Center" Philosophy)
AzTracker applications must prioritize **Visual Excellence** through a strictly **Dark Mode Only, Information-Dense** "Command Center" UI. A simple, basic MVP design is **UNACCEPTABLE**. The user should be wowed at first glance by its utility and speed.
- **Premium Feel:** Implement designs that feel state-of-the-art and highly premium. 
- **Dark Theme Only:** No light mode. No theme toggles. Use `var(--surface-raised)` for cards and elevated surfaces, and `var(--surface-sunken)` for inputs and drawer backgrounds.
- **Color Palettes:** Avoid generic colors (plain red, blue, green). Use the defined CSS Custom Properties. The CRM dashboard accent is `#38bdf8` (`--accent`), and the User dashboard accent is `#FF9900` (`--accent`).
- **Dynamic UI (Micro-interactions for Speed):** The interface must feel alive but fast. Use fast transitions (`150ms`). Do not add staggered entrance animations, animated gradient meshes, or slow bouncing effects.
- **Modern Typography:** Never use browser defaults. Always use modern typography from Google Fonts (e.g., Inter, Roboto, or Outfit) with clear hierarchies (Title 18px, Body 14px, Caption 12px, Mono 11px).
- **No Placeholders:** If an image is needed for a UI mockup, use an image generation tool to create a working demonstration rather than leaving an empty placeholder.

## 3. SEO Best Practices
All user-facing web pages must automatically implement SEO best practices:
- **Title Tags & Meta Descriptions:** Include proper, descriptive tags that accurately summarize page content.
- **Heading Structure:** Use a single `<h1>` per page with proper semantic HTML5 hierarchy.
- **Unique IDs:** Ensure all interactive elements have unique, descriptive IDs for browser testing and tracking.

## 4. UI Ground Rules (Specific to WebApp Dashboards)
*(Inherited from CLAUDE.md & AzTracker UI Enhanced Blueprint)*
- **No Telegram Theme Variables:** NEVER use `tg.themeParams`. The design system is entirely self-contained via custom CSS properties.
- **No Emojis for UI Icons:** Do not use emojis (✅, ❌, etc.) for buttons or status indicators. Use proper SVG icons to prevent font fallback layout shifts and RTL issues.
- **CSS Custom Properties Only:** Never use hardcoded hex/rgba colors in JS template literals. Always reference variables like `var(--surface)`, `var(--accent)`, `var(--danger)`.
- **Card Anatomy:** All product or list cards must utilize a Status Strip (a 3px left border whose color encodes the current status: green=active, amber=paused, red=danger).
- **No Hover:** This is a mobile Telegram WebApp — hover never fires. Use `:active` pseudo-class for press feedback (e.g., `transform: scale(0.97)`).
- **Haptic Feedback:** ALL interactive elements (buttons, tabs, toggles, dialogs) MUST have Telegram haptic feedback using `tg.HapticFeedback.impactOccurred('light'/'medium'/'heavy')` or `notificationOccurred('success'/'warning')`.

**CRITICAL REMINDER:** AESTHETICS ARE VERY IMPORTANT. If your web app looks simple and basic, you have failed the core design directive!
