"use client";

import React, { useRef } from "react";
import { Provider } from "react-redux";
import { makeStore } from "../lib/store";
import { PersistGate } from "redux-persist/integration/react";
import SpinnerbLoader from "@/components/ui/SpinnerbLoader";

type Props = {
  children: React.ReactNode;
};

const Providers = ({ children }: Props) => {
  // Create the store once per app instance, not on every render (navigation)
  const storeRef = useRef<ReturnType<typeof makeStore>>();
  if (!storeRef.current) storeRef.current = makeStore();
  const { store, persistor } = storeRef.current;

  return (
    <Provider store={store}>
      <PersistGate
        loading={
          <div className="flex items-center justify-center h-96">
            <SpinnerbLoader className="w-10 border-2 border-gray-300 border-r-gray-600" />
          </div>
        }
        persistor={persistor}
      >
        {children}
      </PersistGate>
    </Provider>
  );
};

export default Providers;
