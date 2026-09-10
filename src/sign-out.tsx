import { LogOut } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog";

const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export function SignOut({ displayName }: { displayName: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="sign-out-button">
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sign-out-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out of your account?</AlertDialogTitle>
          <AlertDialogDescription>
            Signed in as {displayName}. This also signs this account out of
            other apps protected by the same Cloudflare Access team, not just
            HQ.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p>
          Save any changes first. After signing out, return to HQ to sign in
          with another account.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay signed in</AlertDialogCancel>
          <AlertDialogAction asChild>
            <a href={ACCESS_LOGOUT_PATH}>Sign out of Access</a>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
