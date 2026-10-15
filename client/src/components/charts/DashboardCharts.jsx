import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend, Filler);

const FONT = { family: '"Plus Jakarta Sans", sans-serif', size: 11 };

const baseOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#0F2540',
      titleFont: FONT,
      bodyFont: FONT,
      padding: 10,
      cornerRadius: 8,
      displayColors: false,
    },
  },
};

export function AppointmentsTrendChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400">
        No appointment activity recorded
      </div>
    );
  }

  const labels = data.map((d) => {
    if (!d.day) return '';
    const [y, m, day] = d.day.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  return (
    <div className="h-64">
      <Line
        data={{
          labels,
          datasets: [
            {
              label: 'Appointments',
              data: data.map((d) => Number(d.count)),
              borderColor: '#0D9488',
              backgroundColor: (ctx) => {
                const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 220);
                gradient.addColorStop(0, 'rgba(13,148,136,0.25)');
                gradient.addColorStop(1, 'rgba(13,148,136,0)');
                return gradient;
              },
              fill: true,
              tension: 0.35,
              pointRadius: 3,
              pointBackgroundColor: '#0D9488',
              pointBorderColor: '#fff',
              pointBorderWidth: 1.5,
            },
          ],
        }}
        options={{
          ...baseOptions,
          scales: {
            x: { grid: { display: false }, ticks: { font: FONT, color: '#5B6C81' } },
            y: { beginAtZero: true, ticks: { font: FONT, color: '#5B6C81', precision: 0 }, grid: { color: '#EEF1F4' } },
          },
        }}
      />
    </div>
  );
}

const DEPARTMENT_COLORS = ['#0D9488', '#C9962B', '#2A5277', '#63D3C4', '#DEB253', '#456F99', '#0B7A70'];

export function DepartmentDistributionChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400">
        No department distribution data available
      </div>
    );
  }

  return (
    <div className="h-64">
      <Doughnut
        data={{
          labels: data.map((d) => d.department),
          datasets: [
            {
              data: data.map((d) => Number(d.count)),
              backgroundColor: DEPARTMENT_COLORS,
              borderColor: '#fff',
              borderWidth: 2,
            },
          ],
        }}
        options={{
          ...baseOptions,
          cutout: '68%',
          plugins: {
            ...baseOptions.plugins,
            legend: {
              display: true,
              position: 'right',
              labels: { font: FONT, color: '#374253', boxWidth: 10, boxHeight: 10, padding: 12 },
            },
          },
        }}
      />
    </div>
  );
}

export function MonthlyStatsChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400">
        No monthly performance data available
      </div>
    );
  }

  const labels = data.map((d) => {
    if (!d.month) return '';
    const [y, m] = d.month.split('-');
    return new Date(Number(y), Number(m) - 1).toLocaleDateString('en-US', { month: 'short' });
  });

  return (
    <div className="h-64">
      <Bar
        data={{
          labels,
          datasets: [
            { label: 'Completed', data: data.map((d) => Number(d.completed)), backgroundColor: '#0D9488', borderRadius: 4 },
            { label: 'Cancelled', data: data.map((d) => Number(d.cancelled)), backgroundColor: '#DC2626', borderRadius: 4 },
          ],
        }}
        options={{
          ...baseOptions,
          plugins: {
            ...baseOptions.plugins,
            legend: { display: true, position: 'top', align: 'end', labels: { font: FONT, color: '#374253', boxWidth: 10, boxHeight: 10 } },
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { font: FONT, color: '#5B6C81' } },
            y: { stacked: true, beginAtZero: true, ticks: { font: FONT, color: '#5B6C81', precision: 0 }, grid: { color: '#EEF1F4' } },
          },
        }}
      />
    </div>
  );
}
