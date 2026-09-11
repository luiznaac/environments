import type { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [{ index: true, element: <Dashboard /> }],
  },
];
