import { Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">template</h1>
      </header>
      <Outlet />
    </div>
  );
}
