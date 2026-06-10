import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sessionApiPlugin } from "./server/api";

export default defineConfig({
  plugins: [react(), sessionApiPlugin()],
  server: {
    port: 5180,
  },
});
