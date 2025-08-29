import { useEffect, useState } from "react";
import { Home, Sword, Banknote, Car, Lock, Trophy, LogOut } from "lucide-react";

import Crimes from "./pages/crimes";
import Bank from "./pages/bank";
import Garage from "./pages/garage";
import Prison from "./pages/prison";
import Rankings from "./pages/rankings";

import StatCard from "./components/statcard";

const API_URL = "https://mafia-game-kxct.onrender.com";

export default function App() {
  const [user, setUser] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activeTab, setActiveTab] = useState("home");

  useEffect(() => {
    const saved = localStorage.getItem("user");
    if (saved) setUser(JSON.parse(saved));
  }, []);

  async function login(e) {
    e.preventDefault();
    const res = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) {
      setUser(data.user);
      localStorage.setItem("user", JSON.stringify(data.user));
    } else alert(data.error);
  }

  async function register(e) {
    e.preventDefault();
    const res = await fetch(`${API_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.success) alert("Registered! Now log in.");
    else alert(data.error);
  }

  function logout() {
    setUser(null);
    localStorage.removeItem("user");
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <div className="bg-gray-800 p-6 rounded-xl shadow-lg w-80">
          <h1 className="text-2xl font-bold mb-6 text-center">Mafia Game</h1>
          <form onSubmit={login} className="flex flex-col gap-3">
            <input className="p-2 rounded text-black" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input className="p-2 rounded text-black" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="bg-green-600 hover:bg-green-700 p-2 rounded font-semibold">Login</button>
          </form>
          <button onClick={register} className="mt-4 text-sm underline block mx-auto hover:text-green-400">Or Register</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-gray-900 text-white">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-800 p-6 flex flex-col shadow-lg">
        <h2 className="text-2xl font-bold mb-8 text-green-400">Mafia Game</h2>
        <nav className="flex flex-col gap-3">
          <TabButton icon={<Home size={18} />} label="Home" active={activeTab === "home"} onClick={() => setActiveTab("home")} />
          <TabButton icon={<Sword size={18} />} label="Crimes" active={activeTab === "crimes"} onClick={() => setActiveTab("crimes")} />
          <TabButton icon={<Banknote size={18} />} label="Bank" active={activeTab === "bank"} onClick={() => setActiveTab("bank")} />
          <TabButton icon={<Car size={18} />} label="Garage" active={activeTab === "garage"} onClick={() => setActiveTab("garage")} />
          <TabButton icon={<Lock size={18} />} label="Prison" active={activeTab === "prison"} onClick={() => setActiveTab("prison")} />
          <TabButton icon={<Trophy size={18} />} label="Rankings" active={activeTab === "rankings"} onClick={() => setActiveTab("rankings")} />
        </nav>
        <div className="mt-auto pt-6 border-t border-gray-700">
          <div className="mb-2 text-sm opacity-80">{user.username}</div>
          <button onClick={logout} className="flex items-center gap-2 w-full bg-red-600 hover:bg-red-700 p-2 rounded justify-center">
            <LogOut size={16} /> Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">
        {activeTab === "home" && (
          <div className="space-y-8">
            <div className="bg-gray-800 p-6 rounded-lg shadow-lg flex items-center gap-6">
              <img src="https://i.ibb.co/7y6yC7W/mafia-avatar.png" alt="Avatar" className="w-20 h-20 rounded-full border-2 border-green-500" />
              <div>
                <h2 className="text-2xl font-bold">{user.username}</h2>
                <p className="opacity-75">Rank: {user.rank || "Street Thug"}</p>
                <div className="w-48 bg-gray-700 rounded-full h-3 mt-2">
                  <div className="bg-green-500 h-3 rounded-full" style={{ width: `${user.xp ? (user.xp % 100) : 0}%` }} />
                </div>
                <p className="text-xs mt-1 opacity-70">{user.xp || 0} XP</p>
              </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2 md:grid-cols-4">
              <StatCard title="Money" value={`$${user.money ?? 0}`} image="https://i.ibb.co/k53Qd5k/money-bag.png" />
              <StatCard title="Total Crimes" value={user.total_crimes ?? 0} image="https://i.ibb.co/pj3zRJL/gun.png" />
              <StatCard title="Successful" value={user.successful_crimes ?? 0} image="https://i.ibb.co/0Y0Y3cs/mafia-hat.png" />
              <StatCard title="Unsuccessful" value={user.unsuccessful_crimes ?? 0} image="https://i.ibb.co/SBSj3tM/prison-bars.png" />
            </div>
          </div>
        )}

        {activeTab === "crimes" && <Crimes user={user} API_URL={API_URL} />}
        {activeTab === "bank" && <Bank user={user} API_URL={API_URL} />}
        {activeTab === "garage" && <Garage user={user} API_URL={API_URL} />}
        {activeTab === "prison" && <Prison user={user} API_URL={API_URL} />}
        {activeTab === "rankings" && <Rankings API_URL={API_URL} />}
      </main>
    </div>
  );
}

function TabButton({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded font-medium transition-colors ${
        active ? "bg-gray-700 text-green-400" : "hover:bg-gray-700"
      }`}
    >
      {icon} {label}
    </button>
  );
}
