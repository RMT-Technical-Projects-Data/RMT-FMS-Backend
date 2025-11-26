import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Eye, EyeOff, Mail, Lock, ArrowRight } from "lucide-react";
import { useAuthLogin } from "../../hooks/useAuth";

type LoginResponse = {
  user: {
    role: string;
    [key: string]: any;
  };
  [key: string]: any;
};

export default function Login(): JSX.Element {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const { mutate: login, isPending } = useAuthLogin();
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // basic client-side validation (prevent empty attempts)
    if (!email.trim() || !password) return;

    login(
      { email, password },
      {
        onSuccess: (data: LoginResponse) => {
          // guard against unexpected shapes
          const role = data?.user?.role ? String(data.user.role).toLowerCase() : "";

          switch (role) {
            case "admin":
              navigate("/admin");
              break;
            case "manager":
              navigate("/manager");
              break;
            case "employee":
              navigate("/employee");
              break;
            default:
              // fallback to a safe route
              navigate("/login");
              break;
          }
        },
        onError: (err: any) => {
          // you can wire this to a toast system
          // eslint-disable-next-line no-console
          console.error("Login failed:", err);
        },
      }
    );
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden flex items-center justify-center bg-background">
      {/* Animated background gradient */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.6 }}
        className="absolute inset-0 bg-gradient-to-br from-[#1f1e1a] via-[#141412] to-[#24211c] animate-[pulse_12s_ease-in-out_infinite]"
      />

      {/* Floating orbs (muted gold) */}
      <motion.div
        className="absolute -top-24 -left-24 w-96 h-96 bg-[#b7a57a]/20 rounded-full blur-3xl"
        animate={{ y: [0, 80, 0], x: [0, 40, 0], scale: [1, 1.06, 1] }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-0 right-0 w-[30rem] h-[30rem] bg-[#6b5a4a]/25 rounded-full blur-3xl"
        animate={{ y: [0, -60, 0], x: [0, -30, 0], scale: [1, 1.04, 1] }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Minimal branded hero text */}
      <motion.div
        initial={{ x: -60, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.9 }}
        className="hidden lg:flex flex-col absolute left-20 space-y-4 max-w-lg"
      >
        <h1 className="text-6xl font-extrabold tracking-tight drop-shadow-xl text-[#d6c7a1]">
          E-OFFICE
        </h1>
      </motion.div>

      {/* Login Card */}
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
        className="w-full max-w-md z-10 px-4"
      >
        <Card className="shadow-2xl border-0 bg-[#f4f1e7]/80 backdrop-blur-2xl rounded-3xl p-4 ring-1 ring-[#c8b998]/40">
          <CardHeader className="space-y-4 text-center pb-4">
            <motion.div
              initial={{ y: -12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.5 }}
              className="mx-auto w-20 h-20 bg-[#f4f1e7]/60 rounded-3xl flex items-center justify-center"
            >
              <Lock className="w-10 h-10 text-[#8a7a5a]" />
            </motion.div>
            <CardTitle className="text-3xl font-bold">Welcome Back</CardTitle>
            <CardDescription className="text-base text-muted-foreground">
              Sign in to continue to your workspace
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            <form onSubmit={handleLogin} className="space-y-6">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="space-y-2"
              >
                <Label htmlFor="email" className="text-sm font-medium">
                  Email Address
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10 h-12 bg-input border-border focus:border-[#8a7a5a] focus:ring-2 focus:ring-[#8a7a5a]/20 transition-all duration-200 rounded-xl"
                    placeholder="you@company.com"
                    required
                  />
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="space-y-2"
              >
                <Label htmlFor="password" className="text-sm font-medium">
                  Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-10 pr-10 h-12 bg-input border-border focus:border-[#8a7a5a] focus:ring-2 focus:ring-[#8a7a5a]/20 transition-all duration-200 rounded-xl"
                    placeholder="Enter your password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 }}
              >
                <Button
                  type="submit"
                  className="w-full h-12 text-lg font-semibold rounded-xl group flex items-center justify-center"
                  disabled={isPending}
                >
                  {isPending ? (
                    <div className="flex items-center space-x-2">
                      <span>Signing in...</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2">
                      <span>Sign In</span>
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </div>
                  )}
                </Button>
              </motion.div>
            </form>
          </CardContent>
        </Card>
      </motion.div>

      {/* subtle film grain + vignette overlay for luxe feel */}
      <div className="pointer-events-none absolute inset-0 bg-[url('/textures/film-grain.png')] opacity-5 mix-blend-overlay" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-black/30" />
    </div>
  );
}
