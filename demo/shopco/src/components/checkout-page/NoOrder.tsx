import React from "react";
import Link from "next/link";
import { TbReceiptOff } from "react-icons/tb";
import { Button } from "@/components/ui/button";

const NoOrder = () => {
  return (
    <main className="pb-20">
      <div className="flex items-center flex-col text-gray-300 mt-32">
        <TbReceiptOff strokeWidth={1} className="text-6xl" />
        <span className="block mb-4">There is no recent order to show.</span>
        <Button className="rounded-full w-24" asChild>
          <Link href="/shop">Shop</Link>
        </Button>
      </div>
    </main>
  );
};

export default NoOrder;
