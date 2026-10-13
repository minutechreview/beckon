import { SettingsTabs } from "@/components/SettingsTabs";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SettingsTabs />
      {children}
    </>
  );
}
