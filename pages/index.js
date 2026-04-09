import { useEffect, useMemo, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { getSupabaseClient } from "../lib/supabaseClient";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

export default function HomePage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadOrders() {
      try {
        const supabase = getSupabaseClient();
        if (!supabase) {
          throw new Error(
            "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_KEY in .env.local",
          );
        }

        const { data, error: fetchError } = await supabase
          .from("orders")
          .select("id, customer_name, total_amount, created_at, status")
          .order("created_at", { ascending: true });

        if (fetchError) throw fetchError;
        setOrders(Array.isArray(data) ? data : []);
      } catch (e) {
        setError(e.message || "Failed to fetch orders");
      } finally {
        setLoading(false);
      }
    }

    loadOrders();
  }, []);

  const chartData = useMemo(() => {
    const labels = orders.map((order) =>
      new Date(order.created_at).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
      }),
    );

    return {
      labels,
      datasets: [
        {
          label: "Сумма заказа",
          data: orders.map((order) => Number(order.total_amount || 0)),
          borderColor: "rgb(59, 130, 246)",
          backgroundColor: "rgba(59, 130, 246, 0.25)",
          borderWidth: 2,
          tension: 0.2,
          pointRadius: 3,
        },
      ],
    };
  }, [orders]);

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "top",
        },
      },
      scales: {
        x: {
          ticks: {
            autoSkip: true,
            maxTicksLimit: 12,
          },
          title: {
            display: true,
            text: "Дата создания",
          },
        },
        y: {
          title: {
            display: true,
            text: "Сумма",
          },
          beginAtZero: true,
        },
      },
    }),
    [],
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "48px 16px",
        fontFamily: "Inter, Arial, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: "20px" }}>График заказов</h1>

      {loading && <p>Загрузка...</p>}
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}

      {!loading && !error && (
        <section
          style={{
            width: "80%",
            maxWidth: "1100px",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            padding: "16px",
            background: "#ffffff",
            boxShadow: "0 4px 14px rgba(0, 0, 0, 0.06)",
          }}
        >
          <div style={{ position: "relative", height: "420px" }}>
            <Line data={chartData} options={chartOptions} />
          </div>
          <p style={{ marginTop: "12px", color: "#4b5563" }}>Всего заказов: {orders.length}</p>
        </section>
      )}
    </main>
  );
}
