import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import { CartItem } from "@/lib/features/carts/cartsSlice";
import { CardBrand, PaymentFailureCode } from "@/lib/payment";

export type ShippingInfo = {
  email: string;
  fullName: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
};

export type Order = {
  id: string;
  status: "paid" | "failed";
  createdAt: string;
  items: CartItem[];
  subtotal: number;
  discount: number;
  total: number;
  shipping: ShippingInfo;
  payment: {
    brand: CardBrand;
    last4: string;
    transactionId?: string;
  };
  failure?: {
    code: PaymentFailureCode;
    message: string;
  };
};

// Card details are never stored, only the shipping info and the last order outcome
interface CheckoutState {
  shipping: ShippingInfo | null;
  lastOrder: Order | null;
}

const initialState: CheckoutState = {
  shipping: null,
  lastOrder: null,
};

export const checkoutSlice = createSlice({
  name: "checkout",
  initialState,
  reducers: {
    saveShipping: (state, action: PayloadAction<ShippingInfo>) => {
      state.shipping = action.payload;
    },
    setLastOrder: (state, action: PayloadAction<Order>) => {
      state.lastOrder = action.payload;
    },
  },
});

export const { saveShipping, setLastOrder } = checkoutSlice.actions;

export default checkoutSlice.reducer;
