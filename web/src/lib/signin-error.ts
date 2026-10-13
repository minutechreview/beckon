/** What /signin tells the person when Auth.js or the sign-in form redirects back with `?error=`. */
export function signinErrorMessage(code: string): string {
  if (code === "rate") return "Too many attempts. Wait a few minutes and try again.";
  if (code === "OAuthAccountNotLinked") {
    return "An account with that email already exists. Sign in with an email link instead. GitHub links to it automatically only when the email is verified on GitHub.";
  }
  return "Sign-in didn't work. Try again.";
}
