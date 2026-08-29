import { useNavigate } from 'react-router-dom'
import AuthForm from '@/components/AuthForm'

export default function Login() {
  const nav = useNavigate()
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white mb-1">Catipult</h1>
        <p className="text-zinc-500 mb-6 text-sm">Compute, fill, and verify IRS returns</p>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <AuthForm onSuccess={() => nav('/')} />
        </div>
      </div>
    </div>
  )
}
