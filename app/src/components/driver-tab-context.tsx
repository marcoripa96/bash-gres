"use client";

import { createContext, useContext, useState, useCallback } from "react";

type DriverTabContextValue = {
  activeLabel: string;
  setActiveLabel: (label: string) => void;
};

const DriverTabContext = createContext<DriverTabContextValue | null>(null);

export function DriverTabProvider({
  defaultLabel,
  children,
}: {
  defaultLabel: string;
  children: React.ReactNode;
}) {
  const [activeLabel, setActiveLabel] = useState(defaultLabel);
  return (
    <DriverTabContext.Provider value={{ activeLabel, setActiveLabel }}>
      {children}
    </DriverTabContext.Provider>
  );
}

export function useDriverTab() {
  return useContext(DriverTabContext);
}
