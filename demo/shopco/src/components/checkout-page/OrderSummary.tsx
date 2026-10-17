import React from "react";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CartItem } from "@/lib/features/carts/cartsSlice";

type OrderSummaryProps = {
  items: CartItem[];
  subtotal: number;
  discount: number;
  total: number;
  footer?: React.ReactNode;
};

const OrderSummary = ({
  items,
  subtotal,
  discount,
  total,
  footer,
}: OrderSummaryProps) => {
  return (
    <Card className="w-full rounded-[20px] border-black/10 shadow-none">
      <CardHeader>
        <CardTitle className="text-xl md:text-2xl font-bold">
          Order Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <li
              key={`${item.id}-${item.attributes.join("-")}`}
              className="flex items-center gap-3"
            >
              <div className="relative shrink-0">
                <Image
                  src={item.srcUrl}
                  width={64}
                  height={64}
                  className="size-16 rounded-lg bg-[#F0EEED] object-cover"
                  alt={item.name}
                />
                <Badge className="absolute -right-2 -top-2 rounded-full px-1.5">
                  {item.quantity}
                </Badge>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{item.name}</span>
                <span className="text-sm text-muted-foreground">
                  {item.attributes.join(" / ")}
                </span>
              </div>
              <span className="font-medium">
                ${item.price * item.quantity}
              </span>
            </li>
          ))}
        </ul>
        <Separator />
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="font-bold">${subtotal}</span>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Discount</span>
            <span className="font-bold text-destructive">-${discount}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Delivery Fee</span>
          <span className="font-bold">Free</span>
        </div>
        <Separator />
        <div className="flex items-center justify-between">
          <span>Total</span>
          <span className="text-xl md:text-2xl font-bold">${total}</span>
        </div>
      </CardContent>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
};

export default OrderSummary;
