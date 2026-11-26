{
  description = "Decision Kit TypeScript development environment";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    moonbit-env.url = "path:./moonbit";
  };

  outputs =
    { nixpkgs, moonbit-env, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
        in
        rec {
          ci = default.overrideAttrs (_: {
            shellHook = "";
          });
          default = pkgs.mkShell {
            packages = [
              pkgs.nixfmt
            ];
            shellHook = ''
              vp config
            '';
          };
        }
        // pkgs.lib.optionalAttrs (builtins.hasAttr system moonbit-env.devShells) {
          moonbit-ci = moonbit-env.devShells.${system}.ci;
        }
      );
    };
}
