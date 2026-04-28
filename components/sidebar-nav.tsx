"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

type NavItem = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", match: (p) => p === "/" },
  {
    label: "Clients",
    href: "/clients",
    match: (p) => p === "/clients" || p.startsWith("/clients/"),
  },
  {
    label: "Submit URLs",
    href: "/submit",
    match: (p) => p.startsWith("/submit"),
  },
  {
    label: "Settings",
    href: "/settings",
    match: (p) => p.startsWith("/settings"),
  },
];

export function SidebarNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.label}
            href={item.href}
            className={clsx("nav-link", active && "is-active")}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
