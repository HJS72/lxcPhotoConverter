import { createTheme } from "@mui/material/styles";
import { useMemo, useState } from "react";

type Mode = "light" | "dark";

export const useAppTheme = () => {
  const [mode, setMode] = useState<Mode>("dark");

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode,
          primary: { main: mode === "dark" ? "#ff6a3d" : "#db4b1f" },
          secondary: { main: mode === "dark" ? "#4fc3f7" : "#155f80" },
          background: {
            default: mode === "dark" ? "#141414" : "#f7f3ee",
            paper: mode === "dark" ? "#1f1f1f" : "#fffdf9",
          },
        },
        typography: {
          fontFamily: '"Space Grotesk", sans-serif',
          h1: { fontWeight: 700, letterSpacing: "-0.03em" },
          h2: { fontWeight: 700, letterSpacing: "-0.03em" },
          body2: { fontFamily: '"IBM Plex Mono", monospace' },
        },
        shape: { borderRadius: 16 },
      }),
    [mode]
  );

  return {
    theme,
    mode,
    toggleMode: () => setMode((prev) => (prev === "dark" ? "light" : "dark")),
  };
};
